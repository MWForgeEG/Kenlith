'use strict';

const { isBuiltRequest, withoutTools } = require('./request-builder');
const { checkRecord, pickCapabilityFields } = require('./capabilities');
const { parseSse } = require('./sse');
const { RequestError, errorCode, parseBody } = require('./util');

const API_BASE = 'https://api.openai.com/v1';
// Requests in one tool loop at most (TOOL_LIMITS.maxRounds continuations
// plus the first and a final answer).
const MAX_TOOL_REQUESTS = 6;

// Structured ChatGPT-plan error codes (OpenAI "Errors and recovery").
const PLAN_ERROR_HINTS = {
  subscription_sharing_user_not_eligible: 'This ChatGPT account is not eligible for plan usage in this app.',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT plan usage limit reached. Kenlith did not retry the request. Choose Manage usage to check your usage in ChatGPT settings.',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again later.',
  subscription_sharing_unsupported_capability: 'The request used a model or feature this ChatGPT plan route does not support.',
  subscription_sharing_invalid_user: 'OpenAI did not accept this ChatGPT session.',
  subscription_sharing_user_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again later.'
};

function describeFailure({ status, code, message, requestId }) {
  const parts = [PLAN_ERROR_HINTS[code] || message || 'The request failed.'];
  const details = [status, code].filter(Boolean).join(' ');
  if (details) {
    parts.push(`(${details})`);
  }
  if (requestId) {
    parts.push(`Request ID: ${requestId}`);
  }
  return parts.join(' ');
}

class OpenAIService {
  // 0.11.0: the model catalog of the window this service sends for
  // (src/capabilities.js). Bound by the engine; without it nothing is sent.
  #catalog = undefined;

  constructor(authService) {
    this.authService = authService;
  }

  useCatalog(catalog) {
    this.#catalog = catalog;
  }

  // 0.11.0 (DEC-PLANCHAT-048): every entry of the account's model list, reduced
  // at once to the fields the capability resolver reads (src/capabilities.js
  // pickCapabilityFields); validation and visibility are decided there. One
  // request, the same one 0.10.0 made; nothing else of the list is kept.
  async listModelCatalog(signal) {
    return (await this.#fetchModelEntries(signal)).map(pickCapabilityFields);
  }

  async #fetchModelEntries(signal) {
    const token = await this.authService.getAccessToken();
    const response = await fetch(`${API_BASE}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    });
    const body = await readJsonResponse(response);
    return Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : [];
  }

  async listModels(signal) {
    const candidates = await this.#fetchModelEntries(signal);

    const visible = candidates
      .filter((model) => !model.visibility || model.visibility === 'list')
      .map((model) => ({
        id: String(model.slug || model.id || ''),
        name: String(model.display_name || model.name || model.slug || model.id || '')
      }))
      .filter((model) => model.id && model.name);

    if (!visible.length) {
      throw new Error('No eligible models were returned for this ChatGPT account.');
    }

    return visible;
  }

  // `request` must come from src/request-builder.js; nothing else is sent.
  // `preflight`, when given, runs after the access token is obtained and
  // right before the request goes out: the consent gate's last check (M1-2).
  // If it throws, nothing is sent.
  //
  // 0.5.0 tool loop: when the request offers project tools and the model
  // answers with function calls, `onToolCalls(calls, request)` returns the
  // next request (src/request-builder.js buildToolContinuation) and it is sent
  // the same way, preflight included. Text from every round is streamed to
  // onDelta. A server that refuses tools (ChatGPT plan route:
  // subscription_sharing_unsupported_capability) gets the same request once
  // more without them, before anything was streamed; `toolsUnsupported` then
  // stays set for this service.
  //
  // 0.8.0 (DEC-PLANCHAT-040): a request with an explicit thinking effort is
  // not sent again without tools. The capability refusal does not say whether
  // the tools or the effort was refused; if it was the effort, the second
  // request (which keeps the effort) would fail too and use another request
  // of the plan without the user deciding. The failure is shown, with Default
  // offered (src/engine.js); with Default, the retry below applies as in 0.7.0.
  //
  // 0.9.0 Deep Research: a request with `research` (src/request-builder.js)
  // is sent once with the hosted web_search tool and tool_choice "required".
  // Its answer and citations are taken from the streamed events only
  // (on the plan route `response.completed.output` can be empty), and
  // `onResearch(event)` receives the observable steps:
  //   { kind: 'search', id }                       a web search item started
  //   { kind: 'searched', id, action, status }     it ended (action: search, open_page, find_in_page)
  //   { kind: 'writing' }                          the answer message started
  //   { kind: 'annotation', annotation }           a citation, as received (untrusted)
  // Other events (reasoning items, response.metadata, anything new) are
  // ignored. A research reply in which no web search completed fails.
  async streamResponse({ model, request, signal, onDelta, preflight, onToolCalls, onToolsUnsupported, onResearch }) {
    let current = request;
    let accumulated = '';
    for (let round = 0; ; round += 1) {
      if (round > MAX_TOOL_REQUESTS) {
        throw new Error('The answer needed more project reads than Kenlith allows for one message.');
      }
      let result;
      try {
        result = await this.#streamOnce({ model, request: current, signal, preflight, onResearch, onDelta: (delta) => { accumulated += delta; onDelta(delta); } });
      } catch (error) {
        if (round === 0 && !accumulated && current?.tools && !current.reasoning && error?.code === 'subscription_sharing_unsupported_capability') {
          this.toolsUnsupported = true;
          onToolsUnsupported?.();
          current = withoutTools(current);
          continue;
        }
        throw error;
      }
      // 0.10.0: a request with only the signal also hands its calls to the
      // engine (which ends the turn on the signal; nothing is answered).
      if (!result.calls.length || !(current.tools || current.signal) || typeof onToolCalls !== 'function') {
        return accumulated;
      }
      const next = await onToolCalls(result.calls, current);
      if (!next) return accumulated;
      current = next;
    }
  }

  async #streamOnce({ model, request, signal, onDelta, preflight, onResearch }) {
    if (!isBuiltRequest(request)) {
      throw new Error('This request was not built by Kenlith\'s request builder. Nothing was sent.');
    }
    // 0.8.0: an effort is sent only to the model it was checked for.
    if (request.reasoning && request.reasoningModel !== model) {
      throw new Error('The thinking level was checked for another model. Nothing was sent.');
    }
    // 0.9.0: Deep Research only for the model it was checked for, and never
    // together with project tools or excerpts.
    if (request.research && (request.research.model !== model || request.tools || request.signal || request.autoWeb || request.excerpts.length || request.requiresGate)) {
      throw new Error('This Deep Research request was not built for this model or carries project context. Nothing was sent.');
    }
    // 0.10.0 Path A: hosted search only in a request with no project content,
    // for the model it was checked for, and never together with the signal.
    if (request.autoWeb && (request.autoWeb.model !== model || request.tools || request.signal || request.excerpts.length || request.requiresGate)) {
      throw new Error('This request was not built for web search with this model, or carries project context. Nothing was sent.');
    }
    // 0.12.0 (DEC-PLANCHAT-050/051): web search only where the record offers
    // it (Deep Research where it allows it), and never in a request built from
    // a message that asks not to use the internet, nor in any continuation.
    if ((request.autoWeb || request.signal || request.research?.mode === 'search') && request.capability?.search?.offered !== true) {
      throw new Error('Web search is not available for this model in this session. Nothing was sent.');
    }
    if (request.research?.mode === 'deep-research' && request.capability?.research?.allowed !== true) {
      throw new Error('Deep Research is not available for this model. Nothing was sent.');
    }
    if (request.noWeb && (request.autoWeb || request.signal || request.research)) {
      throw new Error('This message asks not to use the internet, but the request can reach the web. Nothing was sent.');
    }
    if (request.requiresGate && !preflight) {
      throw new Error('Project context needs its last permission check before sending. Nothing was sent.');
    }
    // 0.11.0 (DEC-PLANCHAT-048): the capability record again, after the
    // request's own checks and before the access token is read or anything
    // leaves: issued for this model by this window's own catalog, the session
    // and model list unchanged since, and the level still allowed.
    checkRecord(request.capability, model, request.reasoning ? request.reasoning.effort : 'default');
    if (!this.#catalog || !this.#catalog.isCurrent(request.capability)) {
      throw new Error('The model capabilities were not checked for this window\'s ChatGPT session. Nothing was sent.');
    }
    const { messages, instructions } = request;
    const token = await this.authService.getAccessToken();
    if (preflight) {
      await preflight();
    }
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const input = messages.map((message) => ({
      role: message.role,
      content: message.content
    }));
    const payload = {
      model,
      input: request.continuation?.length ? [...input, ...request.continuation.map((item) => ({ ...item }))] : input,
      instructions,
      store: false,
      stream: true
    };
    // 0.8.0: only from the request builder (src/reasoning.js); absent for Default.
    if (request.reasoning) {
      payload.reasoning = { effort: request.reasoning.effort };
    }
    // 0.10.0 Path B: the internal signal goes with the project tools (or
    // alone), in the namespace form accepted on the plan route.
    const signalTool = request.signal ? JSON.parse(JSON.stringify(request.signal)) : undefined;
    if (request.tools) {
      payload.tools = request.tools.map((tool) => ({ ...tool }));
      if (signalTool) payload.tools.push(signalTool);
      payload.tool_choice = request.toolChoice || 'auto';
      payload.parallel_tool_calls = true;
    } else if (signalTool) {
      payload.tools = [signalTool];
      payload.tool_choice = request.toolChoice || 'auto';
      payload.parallel_tool_calls = true;
    } else if (request.research) {
      // 0.9.0: exactly the two fields of the live-verified research request.
      payload.tools = request.research.tools.map((tool) => ({ ...tool }));
      payload.tool_choice = request.research.toolChoice;
    } else if (request.autoWeb) {
      // 0.10.0 Path A: the model decides whether to search.
      payload.tools = request.autoWeb.tools.map((tool) => ({ ...tool }));
      payload.tool_choice = request.autoWeb.toolChoice;
    }
    // 0.7.0 RC3 (DEC-PLANCHAT-036): every command result in the complete
    // input passes the outbound boundary once more, just before it leaves
    // (src/exec-service.js outboundFilter). If that check fails, nothing is sent.
    if (typeof this.outboundFilter === 'function') {
      try {
        payload.input = this.outboundFilter(payload.input);
      } catch {
        throw new Error('Kenlith could not check the command results in this request. Nothing was sent.');
      }
    }
    const response = await fetch(`${API_BASE}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      await readJsonResponse(response);
    }

    let completed = false;
    let searched = 0;
    // 0.10.0: Path A reports search events too; whether it searched is the model's choice.
    const research = request.research || request.autoWeb ? (event) => { try { onResearch?.(event); } catch { /* display only */ } } : undefined;
    const calls = new Map();
    const noteCall = (item) => {
      if (item?.type !== 'function_call' || typeof item.call_id !== 'string' || !item.call_id) return;
      // 0.10.0: the namespace is kept, so the signal is recognised only with it.
      if (!calls.has(item.call_id)) calls.set(item.call_id, { callId: item.call_id, name: String(item.name || ''), ...(typeof item.namespace === 'string' ? { namespace: item.namespace } : {}), arguments: typeof item.arguments === 'string' ? item.arguments : '' });
    };

    for await (const envelope of parseSse(response.body)) {
      if (envelope.data === '[DONE]') {
        continue;
      }

      const event = envelope.data;
      const type = event?.type || envelope.event;
      if (type === 'response.output_text.delta') {
        onDelta(String(event.delta || ''));
      } else if (research && type === 'response.output_item.added') {
        if (event.item?.type === 'web_search_call') research({ kind: 'search', id: String(event.item.id || '') });
        else if (event.item?.type === 'message') research({ kind: 'writing' });
      } else if (research && type === 'response.output_text.annotation.added') {
        research({ kind: 'annotation', annotation: event.annotation });
      } else if (type === 'response.output_item.done') {
        if (research && event.item?.type === 'web_search_call') {
          const status = String(event.item.status || '');
          if (status === 'completed') searched += 1;
          const action = ['search', 'open_page', 'find_in_page'].includes(event.item.action?.type) ? event.item.action.type : 'other';
          research({ kind: 'searched', id: String(event.item.id || ''), action, status });
        }
        noteCall(event.item);
      } else if (type === 'response.completed') {
        // An isolated web request must have searched; Path A need not.
        if (request.research && !searched) {
          throw new RequestError(request.research.mode === 'search'
            ? 'The web search ended without a completed search, so this is not shown as a search answer. Kenlith did not retry.'
            : 'Deep Research ended without a completed web search, so this is not shown as a research answer. Kenlith did not retry.', { code: 'research-no-search' });
        }
        completed = true;
        for (const item of Array.isArray(event?.response?.output) ? event.response.output : []) noteCall(item);
      } else if (type === 'response.failed') {
        const error = event?.response?.error || event?.error || {};
        throw new RequestError(describeFailure({ code: error.code, message: error.message }), {
          code: error.code,
          param: typeof error.param === 'string' ? error.param : undefined,
          providerMessage: typeof error.message === 'string' ? error.message : undefined
        });
      } else if (type === 'response.incomplete') {
        const reason = event?.response?.incomplete_details?.reason || 'unknown reason';
        throw new Error(`The response was incomplete: ${reason}`);
      } else if (type === 'error') {
        throw new Error(event?.message || event?.error?.message || 'The response stream failed.');
      }
    }

    if (!completed && !signal?.aborted) {
      throw new Error('The stream ended before response.completed.');
    }

    return { calls: [...calls.values()], searched };
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  const body = parseBody(text);

  if (!response.ok) {
    const code = errorCode(body);
    const requestId = response.headers?.get?.('x-request-id') || undefined;
    const message = body?.error?.message
      || body?.error_description
      // Admission failures may use {"detail": "..."} instead of an error object.
      || (typeof body?.detail === 'string' ? body.detail : undefined)
      || body?.message
      || response.statusText;
    throw new RequestError(
      `OpenAI request failed: ${describeFailure({ status: response.status, code, message, requestId })}`,
      { status: response.status, code, requestId, param: typeof body?.error?.param === 'string' ? body.error.param : undefined, providerMessage: typeof message === 'string' ? message : undefined }
    );
  }
  return body;
}

module.exports = { OpenAIService, readJsonResponse };
