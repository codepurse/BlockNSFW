const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackgroundContext } = require('./setup.js');

function attachModelStub(ctx, impl) {
  ctx.self.tf = {
    setBackend: async () => {},
    ready: async () => {}
  };
  ctx.self.nsfwjs = {
    load: impl
  };
}

test('loadAiModel retries after a failed attempt when forced', async () => {
  const ctx = loadBackgroundContext();
  let loadCalls = 0;

  attachModelStub(ctx, async (modelUrl) => {
    loadCalls++;
    if (loadCalls === 1) {
      throw new Error('first load failed');
    }
    return {
      modelUrl,
      classify: async () => []
    };
  });

  await assert.rejects(
    ctx.loadAiModel({ forceRetry: true }),
    /first load failed/
  );

  const model = await ctx.loadAiModel({ forceRetry: true });
  assert.equal(loadCalls, 2);
  assert.equal(typeof model.classify, 'function');
  assert.equal(model.modelUrl, 'nsfwjs/');
});

test('loadAiModel backs off briefly after a failure', async () => {
  const ctx = loadBackgroundContext();

  attachModelStub(ctx, async () => {
    throw new Error('model bootstrap failed');
  });

  await assert.rejects(
    ctx.loadAiModel({ forceRetry: true }),
    /model bootstrap failed/
  );

  await assert.rejects(
    ctx.loadAiModel(),
    /AI model cooling down after failure: model bootstrap failed/
  );

  assert.equal(ctx.getAiModelRetryAfterMs() > 0, true);
});
