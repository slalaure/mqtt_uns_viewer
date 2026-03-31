const { test, expect } = require('@playwright/test');

test.describe('Mapper (ETL) Flow', () => {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';

  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    
    // Wait for the tree view to be fully active and loaded
    await expect(page.locator('#btn-tree-view')).toHaveClass(/active/, { timeout: 10000 });
  });

  test('should create and save a new mapping rule', async ({ page }) => {
    // 1. Publish a dummy message to ensure there is a topic in the tree to click on
    await page.click('#btn-publish-view');
    await page.fill('#publish-topic', 'test/e2e/mapper_source');
    await page.click('#publish-button');
    await expect(page.locator('#publish-status')).toHaveClass(/success/, { timeout: 5000 });

    // 2. Navigate to the Mapper Tab
    await page.click('#btn-mapper-view');
    await expect(page.locator('main#mapper-view')).toHaveClass(/active/);

    // 3. Find and click the newly created topic in the Mapper tree
    // We look for the node containing "mapper_source"
    const topicNode = page.locator('#mapper-tree .node-name', { hasText: 'mapper_source' }).first();
    await topicNode.waitFor({ state: 'visible', timeout: 5000 });
    await topicNode.click();

    // 4. Click Add Target
    await page.click('#mapper-add-target-button');

    // 5. Fill the target topic
    const targetTopicInput = page.locator('.target-output-topic').first();
    await targetTopicInput.waitFor({ state: 'visible' });
    await targetTopicInput.fill('test/e2e/mapped_result');

    // 6. Save the rule
    await page.click('#mapper-save-button');

    // 7. Verify the success message
    const statusMsg = page.locator('#mapper-save-status');
    await expect(statusMsg).toHaveClass(/success/, { timeout: 5000 });
    await expect(statusMsg).toContainText('Live Deployed!');
  });
});