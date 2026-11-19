import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { AuthService } from '../../src/application/auth.ts';
import { credentials } from '../../src/infrastructure/auth-crypto.ts';
import { AuthStore } from '../../src/infrastructure/auth-store.ts';
import { Store } from '../../src/infrastructure/store.ts';
import { makeServer } from '../../src/server.ts';

test('Oficina prepara el PDF y Dirección aplica el coste con el historial separado', async ({
  browser,
}, testInfo) => {
  const store = new Store(':memory:');
  const auth = new AuthService(new AuthStore(store.db), credentials);
  const password = randomBytes(18).toString('base64url');
  const offline = async () => {
    throw new Error('Proveedor externo desactivado en esta prueba');
  };
  const generator = {
    generate: offline,
    status: async () => ({
      provider: 'test',
      model: 'offline',
      available: false,
      message: 'Modo manual',
    }),
  };
  const commercial = {
    select: offline,
    draft: offline,
    extract: offline,
    classify: offline,
    explainTariff: offline,
  };
  const server = makeServer(store, generator, { rank: offline }, commercial);
  const contexts = [];
  try {
    for (const [username, role] of [
      ['oficina', 'office'],
      ['direccion', 'owner'],
      ['almacen', 'warehouse'],
    ])
      await auth.createAccount(username, username, role, password);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('El servidor de prueba no tiene puerto');
    const base = 'http://127.0.0.1:' + address.port;
    const login = async (username, section = 'tariffs') => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(base + '/gestion?section=' + section);
      await page.locator('#login-form [name=username]').fill(username);
      await page.locator('#login-form [name=password]').fill(password);
      await page.locator('#login-form button').click();
      return page;
    };
    const office = await login('oficina');
    await office.locator('#tariff-imports-tab').click();
    await office.getByText('Importar precios desde PDF, archivo o correo', { exact: true }).click();
    const form = office.locator('#tariff-document-form');
    await form.locator('[name=supplierId]').selectOption('demo-lavado');
    await form.locator('[name=reference]').fill('TARIFA-E2E');
    await form.locator('[name=reason]').fill('Revisión de costes de Bruma');
    await form.locator('[name=useAI]').uncheck();
    await form
      .locator('[name=file]')
      .setInputFiles(fileURLToPath(new URL('../fixtures/tariff-bruma.pdf', import.meta.url)));
    const imported = office.waitForResponse(
      (response) =>
        response.url().endsWith('/api/tariff-documents') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Extraer y preparar revisión' }).click();
    const response = await imported;
    expect(response.status()).toBe(201);
    const batch = await response.json();
    const officeBatch = office.locator('article').filter({ hasText: 'TARIFA-E2E' });
    await officeBatch.getByText('Propuestas para Dirección', { exact: true }).click();
    const simulated = office.waitForResponse(
      (response) => response.url().endsWith('/decision') && response.request().method() === 'POST',
    );
    await officeBatch.getByRole('button', { name: 'Preparar propuesta para Dirección' }).click();
    const simulation = await simulated;
    expect(simulation.status()).toBe(201);
    expect((await simulation.json()).report.summary.modelUsed).toBe(false);
    await expect(officeBatch.getByText('Propuestas para Dirección', { exact: true })).toBeVisible();
    const screenshotPath = testInfo.outputPath('simulacion-tarifa.png');
    await officeBatch.screenshot({ path: screenshotPath });
    await testInfo.attach('Simulación revisable de la tarifa', {
      path: screenshotPath,
      contentType: 'image/png',
    });
    await expect(officeBatch.getByRole('button', { name: 'Aplicar costes revisados' })).toHaveCount(
      0,
    );
    const before = store.products().find((product) => product.id === 'nc1');
    const owner = await login('direccion');
    await owner.locator('#tariff-imports-tab').click();
    const ownerBatch = owner.locator('article').filter({ hasText: 'TARIFA-E2E' });
    await ownerBatch.getByRole('checkbox').check();
    const applied = owner.waitForResponse(
      (response) => response.url().endsWith('/apply') && response.request().method() === 'POST',
    );
    await ownerBatch.getByRole('button', { name: 'Aplicar costes revisados' }).click();
    expect((await applied).status()).toBe(200);
    await expect(ownerBatch.getByText(/Propuestas para Dirección.*Desactualizada/)).toBeVisible();
    expect(store.products().find((product) => product.id === 'nc1')).toEqual(before);
    expect(
      store.db
        .prepare('SELECT costCents FROM supplier_offers WHERE supplierId=? AND productId=?')
        .get('demo-lavado', 'nc1')?.costCents,
    ).toBe(5250);
    await owner.goto(base + '/gestion?section=audit');
    await expect(
      owner.getByText('Costes de tarifa aplicados', { exact: true }).first(),
    ).toBeVisible();
    const warehouse = await login('almacen', 'warehouse');
    await expect(warehouse.getByRole('heading', { name: /Almacén/ }).first()).toBeVisible();
    await expect(warehouse.locator('a[href*="section=tariffs"]')).toHaveCount(0);
    expect(store.verifyAudit()).toBe(true);
    expect(batch.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
