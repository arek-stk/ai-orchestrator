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

  await container.repos.tasks.create(
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
  return true;
}
