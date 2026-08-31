const test = require('node:test');
const assert = require('node:assert/strict');

const MarketplaceWebhookController = require('../app/controllers/MarketplaceWebhookController');

test('Falabella: IsPublished=0 no confirma una publicación activa', () => {
  const snapshot = {
    found: true,
    status: 'active',
    qc_status: 'pending',
    is_published: false,
    has_image: true,
    product_errors: []
  };

  assert.deepEqual(
    MarketplaceWebhookController._determineFalabellaTaskLifecycle(snapshot),
    { status: 'pending', isFinal: false, errorMessage: null }
  );
  assert.equal(
    MarketplaceWebhookController._resolveFalabellaMarketplaceDisplayStatus(snapshot),
    'pending'
  );
});

test('Falabella: IsPublished=1 confirma una publicación activa sin errores', () => {
  const snapshot = {
    found: true,
    status: 'active',
    qc_status: 'approved',
    is_published: true,
    has_image: true,
    product_errors: []
  };

  assert.deepEqual(
    MarketplaceWebhookController._determineFalabellaTaskLifecycle(snapshot),
    { status: 'published', isFinal: true, errorMessage: null }
  );
  assert.equal(
    MarketplaceWebhookController._resolveFalabellaMarketplaceDisplayStatus(snapshot),
    'active'
  );
});
