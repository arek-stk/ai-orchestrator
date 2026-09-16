import {
  defaultProjectProfile,
  defaultProjectSettings,
  InMemoryGitHub,
  TaskInputSchema,
  type CheckReport,
  type TaskInput,
} from '@orch/core';
import type { Container } from './container';

const pending: CheckReport = { state: 'pending', conclusion: null, jobs: [], logExcerpt: '', url: null, runIds: [] };
const success: CheckReport = { state: 'success', conclusion: 'success', jobs: [], logExcerpt: '', url: null, runIds: [] };

/** GitHub stand-in used when no GITHUB_TOKEN is configured: two small demo repositories with simulated CI. */
export function createDemoGitHub(): InMemoryGitHub {
  const github = new InMemoryGitHub();
  github.seed(
    { owner: 'demo', name: 'shop' },
    {
      'package.json': JSON.stringify({ name: 'demo-shop', type: 'module', scripts: { test: 'vitest run' } }, null, 2),
      'README.md': '# Demo Shop\n\nA tiny e-commerce backend used to demonstrate the orchestrator.\n',
      'src/index.ts': "export { addToCart, cartTotal } from './cart';\n",
      'src/cart.ts':
        'export interface CartItem { sku: string; price: number; quantity: number }\n\nexport function addToCart(items: CartItem[], item: CartItem): CartItem[] {\n  return [...items, item];\n}\n\nexport function cartTotal(items: CartItem[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.quantity, 0);\n}\n',
      'src/products.ts': "export const products = [{ sku: 'tea', name: 'Green tea', price: 4.5 }];\n",
    },
  );
  github.seed(
    { owner: 'demo', name: 'payments' },
    {
      'package.json': JSON.stringify({ name: 'demo-payments', type: 'module' }, null, 2),
      'README.md': '# Payments API\n',
      'src/server.ts': "export function health() {\n  return { ok: true };\n}\n",
    },
  );
  // Simulated CI: one pending poll, then success.
  github.checks = (_sha, poll) => (poll === 0 ? pending : success);
  return github;
}

function task(input: Partial<TaskInput> & Pick<TaskInput, 'title' | 'goal'>): TaskInput {
  return TaskInputSchema.parse(input);
}

/** Demo projects and tasks so a fresh installation shows the orchestrator working immediately. */
export async function seedDemoData(container: Container): Promise<boolean> {
  if (!container.demoMode() || container.githubKind !== 'in-memory') return false;
  if ((await container.repos.projects.list()).length > 0) return false;

  const shop = await container.repos.projects.create({
    slug: 'demo-shop',
    name: 'Demo Shop',
    description: 'E-commerce backend (demo repository, simulated GitHub and CI).',
    repo: { owner: 'demo', name: 'shop', defaultBranch: 'main' },
    priority: 8,
    autonomyLevel: 3,
    budgetUsd: 20,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'] },
    settings: defaultProjectSettings(),
  });
  const payments = await container.repos.projects.create({
    slug: 'payments-api',
    name: 'Payments API',
    description: 'Payment service (demo repository). Autonomy level 2: changes are prepared but not published.',
    repo: { owner: 'demo', name: 'payments', defaultBranch: 'main' },
    priority: 6,
    autonomyLevel: 2,
    budgetUsd: 20,
    profile: { ...defaultProjectProfile(), languages: ['TypeScript'], criticalPaths: ['src/billing/**'] },
    settings: defaultProjectSettings(),
  });

  const search = await container.repos.tasks.create(
    shop.id,
    task({
      title: 'Add product search',
      goal: 'Customers can search products by name, case-insensitive.',
      acceptanceCriteria: ['Search matches partial names', 'Search is case-insensitive', 'Empty query returns all products'],
      priority: 7,
    }),
    null,
  );
  await container.repos.tasks.create(
    shop.id,
    task({ title: 'Fix README typo', goal: 'Correct the wording in the README introduction.', kind: 'docs', estimatedComplexity: 'simple', risk: 'low', priority: 3 }),
    null,
  );
  await container.repos.tasks.create(
    payments.id,
    task({
      title: 'Implement refund endpoint',
      goal: 'Merchants can refund a captured payment through an authenticated endpoint.',
      acceptanceCriteria: ['Only authenticated merchants can refund', 'Refund amount cannot exceed the captured amount'],
      risk: 'high',
      estimatedComplexity: 'complex',
      priority: 8,
    }),
    null,
  );
  await seedDemoBoard(container, shop.id, search.id);
  await seedDemoRoom(container, shop.id);
  return true;
}

/**
 * Milestones and planned cards for the board and roadmap (ADR-030 stage 2). Planned cards start in Backlog on hold, so
 * the demo scheduler does not pick them up until someone releases them on the board.
 */
async function seedDemoBoard(container: Container, projectId: string, searchTaskId: string): Promise<void> {
  const today = container.clock.now();
  const day = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)).toISOString().slice(0, 10);
  const { milestones } = container.boardRepos;
  const mvp = await milestones.create(projectId, { title: 'Search MVP', description: 'Customers find products by name.', status: 'active', startDate: day(-7), dueDate: day(10), position: 1000 }, null);
  const checkout = await milestones.create(projectId, { title: 'Checkout v2', description: 'Faster checkout with saved carts and wallets.', status: 'planned', startDate: day(8), dueDate: day(35), position: 2000 }, null);
  const launch = await milestones.create(projectId, { title: 'Public launch', description: 'Marketing site, docs and a launch checklist.', status: 'planned', startDate: day(33), dueDate: day(50), position: 3000 }, null);
  await container.repos.tasks.update(searchTaskId, { milestoneId: mvp.id, estimatePoints: 5, labels: ['search'] });

  const planned: Array<{ input: TaskInput; milestoneId: string; estimatePoints: 1 | 2 | 3 | 5 | 8 | 13; labels: string[]; dueDate?: string }> = [
    { input: task({ title: 'Paginate search results', goal: 'Search returns 20 results per page with a next-page cursor.', priority: 6 }), milestoneId: mvp.id, estimatePoints: 3, labels: ['search', 'api'] },
    { input: task({ title: 'Saved carts', goal: 'Signed-in customers find their cart again on another device.', priority: 5 }), milestoneId: checkout.id, estimatePoints: 8, labels: ['checkout'] },
    { input: task({ title: 'Wallet payments', goal: 'Customers can pay with a wallet at checkout.', risk: 'high', priority: 5 }), milestoneId: checkout.id, estimatePoints: 5, labels: ['checkout', 'payments'] },
    { input: task({ title: 'Launch checklist', goal: 'Write the launch checklist for support and operations.', kind: 'docs', risk: 'low', estimatedComplexity: 'simple', priority: 4 }), milestoneId: launch.id, estimatePoints: 2, labels: ['docs'], dueDate: day(45) },
  ];
  let position = 1000;
  for (const card of planned) {
    await container.repos.tasks.create(projectId, card.input, null, {
      status: 'BACKLOG',
      milestoneId: card.milestoneId,
      estimatePoints: card.estimatePoints,
      labels: card.labels,
      dueDate: card.dueDate ?? null,
      boardPosition: position,
      schedulingHold: true,
      holdReason: 'Planned demo card; release it on the board to let the orchestrator start',
    });
    position += 1000;
  }
}

/** A short conversation so the demo room is not empty; pipeline notices follow as soon as the demo runs start. */
async function seedDemoRoom(container: Container, projectId: string): Promise<void> {
  const system = { type: 'system' as const, id: null, name: 'System' };
  const orchestrator = { type: 'orchestrator' as const, id: null, name: 'Orchestrator' };
  const maria = { type: 'human' as const, id: null, name: 'maria (demo)' };
  const jonas = { type: 'human' as const, id: null, name: 'jonas (demo)' };
  await container.room.post({
    projectId,
    author: system,
    intent: 'status',
    body: 'Welcome to the Demo Shop room. People, the orchestrator and its agents post here; stage results, approvals and decisions of pipeline runs appear automatically.',
  });
  const question = await container.room.post({ projectId, author: maria, intent: 'question', body: 'Should product search also match SKUs? Support pastes them from invoices.' });
  await container.room.post({
    projectId,
    author: jonas,
    intent: 'answer',
    threadId: question.message.id,
    body: 'Not in the first version. Name search first, SKUs as a follow-up task. Background: https://github.com/demo/shop#readme',
  });
  await container.room.post({ projectId, author: orchestrator, intent: 'status', body: 'Two tasks are ready: "Add product search" and "Fix README typo". Planned work for the next milestones waits on hold in the Backlog column of the board. Progress shows up here.' });
}
