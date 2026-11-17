import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  analyzeStock,
  ConfigureStockPolicy,
  DEFAULT_STOCK_POLICY,
  salesOptions,
} from '../src/application/stock-analysis.ts';
import type { Sale } from '../src/application/commerce.ts';
import {
  businessContext,
  rankOpportunities,
  businessProposalInput,
} from '../src/application/business.ts';
import { StockPolicyStore } from '../src/infrastructure/stock-policy-store.ts';
import { CommerceStore } from '../src/infrastructure/commerce-store.ts';
import { Store } from '../src/infrastructure/store.ts';
import { makeServer } from '../src/server.ts';
import { sessions } from './auth-fixture.ts';
const products = [
  {
    id: 'p',
    sku: 'P1',
    name: 'Producto de prueba',
    category: 'Interior',
    priceCents: 1000,
    costCents: 500,
    version: 1,
  },
  {
    id: 'q',
    sku: 'P2',
    name: 'Alternativa de prueba',
    category: 'Interior',
    priceCents: 1200,
    costCents: 600,
    version: 1,
  },
];
const sale = (productId: string, quantity: number, status: Sale['status'] = 'confirmed'): Sale => ({
  id: 'private-order',
  actorId: 'private-actor',
  requestId: 'private-request',
  createdAt: '2026-10-10T12:00:00Z',
  totalCents: 1000,
  costCents: 500,
  customer: { name: 'Private Name', email: 'secret@example.com', address: 'Private address' },
  lines: [
    {
      productId,
      name: 'Producto',
      quantity,
      expectedPriceCents: 1000,
      unitPriceCents: 1000,
      unitCostCents: 500,
    },
  ],
  status,
});
const from = '2026-10-01',
  to = '2026-10-30';

test('el pack compara una unidad de cada producto y requiere existencias de ambos', () => {
  const [first, second] = products;
  const pack = salesOptions(first!, 1, { product: second!, stock: 1 }).find((o) => o.id === 'pack');
  assert.equal(pack?.offer?.units, 2);
  assert.equal(pack?.offer?.revenue, 2090);
  assert.equal(pack?.offer?.gross, 990);
  assert.equal(
    salesOptions(first!, 1, { product: second!, stock: 0 }).some((o) => o.id === 'pack'),
    false,
  );
});
test('punto de pedido, cobertura y cantidad usan ritmo registrado y plazo configurado', () => {
  const report = analyzeStock(
    products,
    [
      { productId: 'p', quantity: 4 },
      { productId: 'q', quantity: 50 },
    ],
    [sale('p', 30)],
    from,
    to,
    [{ productId: 'p', leadDays: 3, safetyDays: 2, targetDays: 20, minimumUnits: 2, version: 1 }],
  );
  const row = report.rows[0]!;
  assert.equal(row.dailyRate, 1);
  assert.equal(row.reorderPoint, 5);
  assert.equal(row.targetUnits, 20);
  assert.equal(row.suggestedOrderUnits, 16);
  assert.equal(row.coverageDays, 4);
  assert.ok(row.signals.some((s) => s.code === 'reorder'));
  assert.equal(row.policyIsDefault, false);
  for (const secret of [
    'private-order',
    'private-actor',
    'private-request',
    'Private Name',
    'secret@example.com',
    'Private address',
  ])
    assert.ok(!JSON.stringify(report).includes(secret));
});
test('sin ventas no inventa compra y mínimo explícito avisa sin calcular unidades', () => {
  const report = analyzeStock(
    products,
    [
      { productId: 'p', quantity: 2 },
      { productId: 'q', quantity: 10 },
    ],
    [],
    from,
    to,
    [{ productId: 'p', ...DEFAULT_STOCK_POLICY, version: 1 }],
  );
  const row = report.rows[0]!;
  assert.equal(row.coverageDays, null);
  assert.equal(row.suggestedOrderUnits, null);
  assert.ok(row.signals.some((s) => s.code === 'reorder'));
  assert.ok(row.actions.some((a) => a.includes('fotografías')));
  assert.deepEqual(
    row.salesOptions.map((option) => option.id),
    ['visibility', 'discount', 'second-half'],
  );
  assert.equal(
    report.rows[1]!.salesOptions.find((option) => option.id === 'three-for-two')?.offer?.revenue,
    2400,
  );
  assert.equal(report.rows[1]!.policyIsDefault, true);
});
test('excluye devueltos/cancelados/fuera de periodo y ofrece alternativas con ventas de su categoría', () => {
  const report = analyzeStock(
    products,
    [
      { productId: 'p', quantity: 20 },
      { productId: 'q', quantity: 20 },
    ],
    [
      sale('p', 10, 'returned'),
      sale('p', 10, 'cancelled'),
      { ...sale('p', 10), createdAt: '2026-09-01T00:00:00Z' },
      sale('q', 3),
    ],
    from,
    to,
    [],
  );
  assert.equal(report.rows[0]!.unitsSold, 0);
  assert.equal(report.rows[0]!.alternatives[0]?.sku, 'P2');
  assert.ok(report.rows[1]!.signals.some((s) => s.code === 'high-coverage'));
  assert.equal(report.rows[1]!.suggestedOrderUnits, null);
});
test('configuración valida roles/versiones y fallo de evento revierte guardado sin modificar stock', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const repo = new StockPolicyStore(store),
    service = new ConfigureStockPolicy(repo),
    actor = { id: 'editor', role: 'editor' },
    body = { ...DEFAULT_STOCK_POLICY, expectedVersion: 0 };
  const before = store.products();
  for (const role of ['viewer', 'reviewer'])
    assert.throws(() => service.execute({ id: role, role }, 'nc1', body));
  for (const patch of [{ leadDays: -1 }, { targetDays: 2 }, { minimumUnits: 1.5 }, { extra: true }])
    assert.throws(() => service.execute(actor, 'nc1', { ...body, ...patch }));
  const policy = service.execute(actor, 'nc1', body);
  assert.equal(policy.version, 1);
  assert.throws(() => service.execute(actor, 'nc1', body));
  repo.record = () => {
    throw Error('disk');
  };
  assert.throws(() => service.execute(actor, 'nc1', { ...body, leadDays: 8, expectedVersion: 1 }));
  assert.equal(repo.all()[0]!.leadDays, 7);
  assert.deepEqual(store.products(), before);
});
test('IA recibe prioridad de reposición y no puede convertirla en descuento de categoría', async () => {
  const context = businessContext(
    products,
    [
      { productId: 'p', quantity: 10 },
      { productId: 'q', quantity: 10 },
    ],
    [],
    from,
    to,
  );
  context.opportunities.push({
    id: 'reorder',
    category: 'Interior',
    code: 'stock-reorder',
    message: 'Revisar reposición',
  });
  await rankOpportunities(context, {
    rank: async (input) => {
      assert.equal(input.opportunities.find((o) => o.id === 'reorder')!.priority, 1);
      return { ids: ['reorder'] };
    },
  });
  await assert.rejects(
    rankOpportunities(context, { rank: async () => ({ ids: [context.opportunities[0]!.id] }) }),
  );
  assert.throws(() =>
    businessProposalInput(context, {
      contextHash: 'hash',
      signalId: 'reorder',
      basisPoints: -500,
      reason: 'Intento de descuento automático',
    }),
  );
});
test('HTTP protege políticas y cambio de configuración invalida contexto IA', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const unused = async () => {
    throw new Error('Llamada inesperada');
  };
  const server = makeServer(store, undefined, undefined, {
    select: unused,
    draft: unused,
    extract: unused,
    classify: unused,
    async prioritize(tasks) {
      assert.ok(tasks.every((task) => !task.detail.includes('por debajo')));
      return { ids: tasks.map(({ id }) => id).reverse() };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const a = server.address();
  assert.ok(a && typeof a !== 'string');
  const base = 'http://127.0.0.1:' + a.port,
    headers = sessions(store, base);
  assert.equal((await fetch(base + '/api/stock-analysis')).status, 401);
  const read = await fetch(base + '/api/stock-analysis', { headers: headers('lucia') });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).rows.length, 18);
  const compare = (actor: string, companionId: string) =>
    fetch(base + '/api/proposals/offer-comparison', {
      method: 'POST',
      headers: headers(actor),
      body: JSON.stringify({ productId: 'nc1', companionId }),
    });
  assert.equal((await compare('lucia', 'nc2')).status, 403);
  assert.equal((await compare('elena', 'nc1')).status, 400);
  const comparison = await compare('elena', 'nc2');
  assert.equal(comparison.status, 200);
  const options = (await comparison.json()).options as ReturnType<typeof salesOptions>;
  assert.equal(options.find((option) => option.id === 'pack')?.offer?.units, 2);
  const advice = () =>
    fetch(base + '/api/stock-analysis/advice', {
      method: 'POST',
      headers: headers('elena'),
      body: JSON.stringify({ productId: 'nc1' }),
    });
  const ranked = await advice();
  assert.equal(ranked.status, 200);
  const result = await ranked.json();
  assert.equal(result.modelUsed, true);
  assert.doesNotMatch(result.text, /Oferta 3×2/);
  const prior = await (
    await fetch(base + '/api/business-context', { headers: headers('elena') })
  ).json();
  const send = (actor: string) =>
    fetch(base + '/api/stock-policies/nc1', {
      method: 'POST',
      headers: headers(actor),
      body: JSON.stringify({ ...DEFAULT_STOCK_POLICY, expectedVersion: 0 }),
    });
  assert.equal((await send('lucia')).status, 403);
  assert.equal((await send('elena')).status, 200);
  assert.equal((await send('elena')).status, 409);
  const next = await (
    await fetch(base + '/api/business-context', { headers: headers('elena') })
  ).json();
  assert.notEqual(next.contextHash, prior.contextHash);
  store.db.prepare('UPDATE inventory SET quantity=0 WHERE productId=?').run('nc1');
  assert.equal((await advice()).status, 409);
  const workspace = await (
    await fetch(base + '/api/workspace', { headers: headers('elena') })
  ).json();
  assert.ok(workspace.stockReviewCount >= 1);
});

test('HTTP: las ventas históricas del escenario se reflejan en existencias y análisis comercial', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const commerce = new CommerceStore(store);
  const period = { from: '2001-01-01', to: '2001-02-28' };
  for (const [id, createdAt] of [
    ['within', '2001-02-04T12:00:00Z'],
    ['outside', '2001-03-04T12:00:00Z'],
  ] as const) {
    commerce.saveSale({ ...sale('nc1', 2), id, requestId: id, createdAt });
  }
  store.transaction(() => {
    for (let index = 0; index < 1001; index++) store.record('elena', 'scenario.check', { index });
  });
  const env = {
    CHANGELAB_SCENARIO: 'Escenario de prueba',
    CHANGELAB_SCENARIO_FROM: period.from,
    CHANGELAB_SCENARIO_TO: period.to,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const server = (() => {
    try {
      Object.assign(process.env, env);
      return makeServer(store);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const headers = sessions(store, base)('elena');
  const workspace = await (await fetch(base + '/api/workspace', { headers })).json();
  assert.deepEqual(workspace.scenarioPeriod, period);
  assert.equal(
    workspace.audit.filter((entry: { action: string }) => entry.action === 'scenario.check').length,
    1001,
  );
  assert.equal(workspace.auditValid, true);
  const stock = await (await fetch(base + '/api/stock-analysis', { headers })).json();
  const { context } = await (await fetch(base + '/api/business-context', { headers })).json();
  assert.deepEqual({ from: stock.from, to: stock.to }, period);
  assert.deepEqual({ from: context.from, to: context.to }, period);
  const row = stock.rows.find((item: { productId: string }) => item.productId === 'nc1');
  assert.equal(row.unitsSold, 2);
  assert.equal(
    context.categories.find((item: { category: string }) => item.category === row.category)
      .unitsSold,
    2,
  );
});
