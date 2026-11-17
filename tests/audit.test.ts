import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAudit } from '../src/application/audit.ts';
import { sha, Store } from '../src/infrastructure/store.ts';
import { ProposalService, actorFor } from '../src/application/proposals.ts';
const digest = { hash: sha };
test('historial de compras muestra proveedor y motivo y reserva el identificador interno', () => {
  const id = 'd54a7a66-d683-4bbd-b07c-9a51bf91b824';
  const summary = (action: string, detail: object) =>
    describeAudit({ action, detail: JSON.stringify({ id, ...detail }) }, [], digest);
  const prepared = summary('purchase.created', {
    supplierName: 'Bruma',
    reason: 'Falta de stock',
  });
  assert.equal(prepared.instruction, 'Proveedor: Bruma · Falta de stock');
  assert.equal(prepared.operationId, id);
  assert.equal(summary('purchase.approved', {}).instruction, '');
  assert.equal(
    summary('purchase.changes_requested', { review: { reason: 'Revisar la cantidad' } })
      .instruction,
    'Revisar la cantidad',
  );
  assert.equal(
    summary('purchase.received', { reference: 'ALB-12' }).instruction,
    'Referencia: ALB-12',
  );
});
test('historial de correo distingue reintento, captura local y aceptación del proveedor', () => {
  const summary = (action: string) =>
    describeAudit({ action, detail: JSON.stringify({ orderId: 'pedido-qa' }) }, [], digest)
      .instruction;
  assert.match(summary('mail.retry-requested')!, /Todavía no acredita envío ni entrega/);
  assert.match(summary('mail.preview')!, /no se ha enviado correo externo/);
  assert.match(summary('mail.sent')!, /No confirma recepción en el buzón/);
});
function fixture() {
  const store = new Store(':memory:');
  const service = new ProposalService(
    store,
    digest,
    { now: () => new Date().toISOString() },
    { next: () => 'proposal-test' },
  );
  return {
    store,
    proposal: service.create(actorFor('elena'), {
      instruction: 'Ajuste de campaña',
      plan: { category: 'Lavado exterior', basisPoints: 500 },
    }),
  };
}
test('historial antiguo recupera contexto solo de la propuesta verificada y conserva precios del evento', () => {
  const { store, proposal } = fixture();
  try {
    const details = { id: proposal.id, digest: proposal.digest, changes: proposal.changes };
    const entry = { action: 'proposal.applied', detail: JSON.stringify(details) };
    const result = describeAudit(entry, [proposal], digest);
    assert.equal(result.plan?.category, 'Lavado exterior');
    assert.equal(result.plan?.basisPoints, 500);
    assert.equal(result.createdBy, 'elena');
    assert.equal(result.changes[0]?.beforeCents, 7990);
    assert.equal(result.changes[0]?.afterCents, 8390);
    assert.equal(entry.detail, JSON.stringify(details));
  } finally {
    store.close();
  }
});
test('no atribuye motivo ni porcentaje a partir de una propuesta manipulada', () => {
  const { store, proposal } = fixture();
  try {
    const result = describeAudit(
      {
        action: 'proposal.applied',
        detail: JSON.stringify({
          id: proposal.id,
          digest: proposal.digest,
          changes: proposal.changes,
        }),
      },
      [{ ...proposal, instruction: 'Alterado' }],
      digest,
    );
    assert.equal(result.plan, null);
    assert.equal(result.instruction, null);
    assert.equal(result.changes.length, 3);
  } finally {
    store.close();
  }
});
test('eventos nuevos explican el cambio aunque la propuesta no esté disponible', () => {
  const result = describeAudit(
    {
      action: 'proposal.applied',
      detail: JSON.stringify({
        id: 'p',
        plan: { category: 'Accesorios de limpieza', basisPoints: -500 },
        instruction: 'Rebaja',
        createdBy: 'editor-id',
        actorName: 'Ana',
        changes: [{ productId: 'x', name: 'Producto', beforeCents: 1000, afterCents: 950 }],
      }),
    },
    [],
    digest,
  );
  assert.equal(result.plan?.basisPoints, -500);
  assert.equal(result.actorName, 'Ana');
  assert.equal(result.changes[0]?.afterCents, 950);
});
test('detalle ilegible y filas inválidas no interrumpen el historial', () => {
  assert.equal(
    describeAudit({ action: 'proposal.applied', detail: '{mal JSON' }, [], digest).available,
    false,
  );
  const result = describeAudit(
    {
      action: 'proposal.simulated',
      detail: JSON.stringify({
        changes: [null, { name: 'X', beforeCents: '100', afterCents: 90 }],
        findings: [null, { message: 'Margen insuficiente' }],
      }),
    },
    [],
    digest,
  );
  assert.equal(result.changes.length, 0);
  assert.deepEqual(result.findings, ['Margen insuficiente']);
});
