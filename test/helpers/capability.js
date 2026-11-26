'use strict';

// Kenlith 0.11.0 tests (DEC-PLANCHAT-048): genuine capability records for
// tests that build or send a request without an engine. The records come from
// the real resolver over a synthetic catalog loaded through the normal
// ModelCatalog.load path; src/ has no test-only way to make one.
//
//   const { capabilityReady, capabilityFor, withCapability, bindService } = require('./helpers/capability');
//   test.before(() => capabilityReady);
//   buildRequest(withCapability({ instructions, history, text, model: 'gpt-6.1-sol' }));
//   bindService(new OpenAIService(auth));   // the service sends only this catalog's records

const { ModelCatalog } = require('../../src/capabilities');

const DEFAULT_TEST_MODEL = 'gpt-alpha';
const ACCOUNT = 'test-subject|test-account';

// Synthetic entries in the /v1/models shape. No metadata unless a test needs
// it: approved slugs then follow their approved rule (0.10.0 behavior), the
// others offer Default only.
const ENTRIES = Object.freeze([
  { slug: 'gpt-alpha', display_name: 'GPT Alpha', visibility: 'list' },
  { slug: 'gpt-beta', display_name: 'GPT Beta', visibility: 'list' },
  { slug: 'model-a', display_name: 'Model A', visibility: 'list' },
  { slug: 'm', display_name: 'M', visibility: 'list' },
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
  { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list' },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
  { slug: 'gpt-7-preview', display_name: 'GPT-7 Preview', visibility: 'list' },
  { slug: 'gpt-7-nova', display_name: 'GPT-7-Nova', visibility: 'list' }
]);

let catalog;
const capabilityReady = (async () => {
  const loading = new ModelCatalog();
  await loading.load(ACCOUNT, async () => ENTRIES.map((entry) => ({ ...entry })));
  catalog = loading;
  return catalog;
})();

function testCatalog() {
  if (!catalog) throw new Error('await capabilityReady first (test.before)');
  return catalog;
}

function capabilityFor(model) {
  return testCatalog().resolve(model);
}

// The same arguments with the model's record; a call without a model uses
// DEFAULT_TEST_MODEL (no Thinking levels, no web search), which builds the
// same request 0.10.0 built without a model.
function withCapability(args) {
  const model = args.model === undefined ? DEFAULT_TEST_MODEL : args.model;
  return { ...args, model, capability: capabilityFor(model) };
}

function bindService(service) {
  service.useCatalog(testCatalog());
  return service;
}

// For test files that build requests directly: the builder with each call's
// model record added (assertions unchanged). Refusal tests for a missing,
// forged or stale record call the raw builder (test/capability-resolver.test.js).
function boundBuilder(build) {
  return (args) => build(withCapability(args));
}

// For test files that use the real service without an engine: constructed
// bound to the test catalog. An engine built on it binds its own catalog
// instead (src/engine.js), exactly as in the extension.
function boundService(RawService) {
  return class TestBoundService extends RawService {
    constructor(...args) {
      super(...args);
      this.useCatalog(testCatalog());
    }
  };
}

module.exports = { DEFAULT_TEST_MODEL, ENTRIES, bindService, boundBuilder, boundService, capabilityFor, capabilityReady, testCatalog, withCapability };
