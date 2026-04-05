const { test, expect } = require('@playwright/test');

test.describe('Cross-View State Synchronization', () => {
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

  test('should retain topic selection when switching between Tree, Mapper, and Chart views', async ({ page }) => {
    const testTopic = 'test/sync/context';
    const testNodeName = 'context';

    // 1. Publish a dummy message to create a node in the tree
    await page.click('#btn-publish-view');
    await page.fill('#publish-topic', testTopic);
    await page.click('#publish-button');
    await expect(page.locator('#publish-status')).toHaveClass(/success/, { timeout: 5000 });

    // 2. Navigate to the Tree View
    await page.click('#btn-tree-view');
    await expect(page.locator('main#tree-view')).toHaveClass(/active/);

    // 3. Find and click the newly created topic in the main tree
    const topicNode = page.locator('#mqtt-tree .node-name', { hasText: testNodeName }).first();
    await topicNode.waitFor({ state: 'visible', timeout: 5000 });
    
    // Ensure the tree node is clicked (targeting the container)
    await topicNode.locator('..').click(); // click the .node-container
    
    // Verify it gets the 'selected' class
    await expect(topicNode.locator('..')).toHaveClass(/selected/);

    // Verify the main payload viewer shows the topic
    await expect(page.locator('#payload-topic')).toContainText(testNodeName);

    // 4. Switch to Mapper View
    await page.click('#btn-mapper-view');
    await expect(page.locator('main#mapper-view')).toHaveClass(/active/);

    // Verify the Mapper automatically hydrated the selection
    const mapperSourceInput = page.locator('#mapper-source-topic');
    await expect(mapperSourceInput).toBeVisible();
    await expect(mapperSourceInput).toHaveValue(new RegExp(testTopic));

    // Verify the Mapper tree also highlights the node
    const mapperTopicNode = page.locator('#mapper-tree .node-name', { hasText: testNodeName }).first();
    await expect(mapperTopicNode.locator('..')).toHaveClass(/selected/);

    // 5. Switch to Chart View
    await page.click('#btn-chart-view');
    await expect(page.locator('main#chart-view')).toHaveClass(/active/);

    // Verify the Chart payload viewer hydrated the selection
    await expect(page.locator('#chart-payload-topic')).toContainText(testNodeName);

    // Verify the Chart tree also highlights the node
    const chartTopicNode = page.locator('#chart-tree .node-name', { hasText: testNodeName }).first();
    await expect(chartTopicNode.locator('..')).toHaveClass(/selected/);

    // 6. Switch back to Tree View
    await page.click('#btn-tree-view');
    await expect(page.locator('main#tree-view')).toHaveClass(/active/);

    // Verify it is STILL selected
    await expect(topicNode.locator('..')).toHaveClass(/selected/);
  });
});
