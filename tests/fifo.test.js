const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('async function ensureProductLots');
const end = html.indexOf('\n\nfunction updateRecord', start);
assert.ok(start >= 0 && end > start, 'Could not locate the production FIFO helpers in index.html');
const productionHelpers = html.slice(start, end);

function makeHarness({ products = [], lots = [] } = {}) {
  const stores = {
    products: structuredClone(products),
    stockLots: structuredClone(lots),
  };
  let nextLotId = Math.max(0, ...stores.stockLots.map(l => Number(l.id) || 0)) + 1;

  const getAllRecords = async name => structuredClone(stores[name] || []);
  const addRecord = async (name, data) => {
    const record = structuredClone(data);
    if (name === 'stockLots' && record.id == null) record.id = nextLotId++;
    stores[name].push(record);
    return record.id;
  };
  const updateRecord = async (name, data) => {
    const index = stores[name].findIndex(x => x.id === data.id);
    if (index < 0) throw new Error('Record not found: ' + data.id);
    stores[name][index] = structuredClone(data);
    return data.id;
  };
  const getRecordById = async (name, id) => {
    const value = stores[name].find(x => x.id === id);
    return value ? structuredClone(value) : undefined;
  };
  const roundCUP = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  const helpers = new Function(
    'getAllRecords', 'addRecord', 'updateRecord', 'getRecordById', 'roundCUP',
    productionHelpers + '\nreturn { ensureProductLots, consumeStockFIFO, addStockLot, quoteStockFIFO, restoreStockAllocations };'
  )(getAllRecords, addRecord, updateRecord, getRecordById, roundCUP);

  return { ...helpers, stores };
}

test('FIFO consumes oldest lot first and calculates weighted unit cost/sale price', async () => {
  const h = makeHarness({ lots: [
    { id: 1, productId: 7, location: 'Tienda', quantityRemaining: 2, originalQuantity: 2, unitCost: 10, unitSale: 15, createdAt: 100 },
    { id: 2, productId: 7, location: 'Tienda', quantityRemaining: 3, originalQuantity: 3, unitCost: 20, unitSale: 30, createdAt: 200 },
  ] });
  const result = await h.consumeStockFIFO({ id: 7, quantity: 5, location: 'Tienda' }, 4);
  assert.deepEqual(result.allocations.map(x => [x.lotId, x.quantity]), [[1, 2], [2, 2]]);
  assert.equal(result.averageCost, 15);
  assert.equal(result.averageSale, 22.5);
  assert.deepEqual(h.stores.stockLots.map(x => x.quantityRemaining), [0, 1]);
});

test('FIFO rejects fractional, zero, negative and insufficient quantities without consuming lots', async () => {
  const h = makeHarness({ lots: [
    { id: 1, productId: 7, location: 'Tienda', quantityRemaining: 2, originalQuantity: 2, unitCost: 10, unitSale: 15, createdAt: 100 },
  ] });
  const product = { id: 7, quantity: 2, location: 'Tienda' };
  for (const quantity of [0, -1, 1.5]) {
    await assert.rejects(() => h.consumeStockFIFO(product, quantity), /entero positivo/);
  }
  await assert.rejects(() => h.consumeStockFIFO(product, 3), /insuficientes/);
  assert.equal(h.stores.stockLots[0].quantityRemaining, 2);
});

test('FIFO quote does not mutate lots and rejects insufficient stock', async () => {
  const h = makeHarness({ lots: [
    { id: 1, productId: 7, location: 'Tienda', quantityRemaining: 1, originalQuantity: 1, unitCost: 8, unitSale: 12, createdAt: 100 },
    { id: 2, productId: 7, location: 'Tienda', quantityRemaining: 2, originalQuantity: 2, unitCost: 14, unitSale: 20, createdAt: 200 },
  ] });
  const product = { id: 7, quantity: 3, location: 'Tienda' };
  const quote = await h.quoteStockFIFO(product, 2);
  assert.equal(quote.averageCost, 11);
  assert.equal(quote.averageSale, 16);
  assert.deepEqual(h.stores.stockLots.map(x => x.quantityRemaining), [1, 2]);
  await assert.rejects(() => h.quoteStockFIFO(product, 4), /insuficiente/);
});

test('restoreStockAllocations restores original lot balances', async () => {
  const h = makeHarness({ lots: [
    { id: 1, productId: 7, location: 'Tienda', quantityRemaining: 0, originalQuantity: 2, unitCost: 10, unitSale: 15, createdAt: 100 },
  ] });
  await h.restoreStockAllocations(7, 'Tienda', [
    { lotId: 1, quantity: 2, unitCost: 10, unitSale: 15, createdAt: 100 },
  ]);
  assert.equal(h.stores.stockLots[0].quantityRemaining, 2);
});

test('legacy stock without lot layers is backfilled to match product quantity', async () => {
  const h = makeHarness({ lots: [
    { id: 1, productId: 7, location: 'Tienda', quantityRemaining: 1, originalQuantity: 1, unitCost: 10, unitSale: 15, createdAt: 100 },
  ] });
  const layers = await h.ensureProductLots({ id: 7, quantity: 4, price: 20, salePrice: 30, location: 'Tienda', dateAdded: 50 });
  assert.equal(layers.reduce((sum, lot) => sum + lot.quantityRemaining, 0), 4);
  assert.equal(layers.length, 2);
  assert.equal(layers.find(lot => lot.migrated).quantityRemaining, 3);
});
