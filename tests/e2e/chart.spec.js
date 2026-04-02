const { test, expect } = require('@playwright/test');

test.describe('Chart Generation & Configuration Flow', () => {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const testTopic = `test/e2e/chart_telemetry_${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    // 1. Authenticate
    await page.goto('/login');
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    
    await expect(page.locator('#btn-tree-view')).toHaveClass(/active/, { timeout: 10000 });
  });

  test('should plot a variable and save the chart configuration', async ({ page }) => {
    // 2. Publish dummy data to ensure we have a topic with a numeric variable
    await page.click('#btn-publish-view');
    await expect(page.locator('main#publish-view')).toHaveClass(/active/);
    
    await page.fill('#publish-topic', testTopic);
    // Select JSON format
    await page.selectOption('#publish-format', 'json');
    
    // Fill the Ace Editor with a dummy JSON payload containing a numeric value
    const payload = JSON.stringify({ temperature: 42.5, pressure: 1013 });
    await page.evaluate((data) => {
        ace.edit("publish-payload-editor").setValue(data);
    }, payload);
    
    await page.click('#publish-button');
    await expect(page.locator('#publish-status')).toHaveClass(/success/, { timeout: 5000 });

    // 3. Navigate to Chart View
    await page.click('#btn-chart-view');
    await expect(page.locator('main#chart-view')).toHaveClass(/active/);

    // 4. Locate and click the newly created topic in the Chart Tree
    // We split by slash and look for the last part to find the leaf node
    const topicParts = testTopic.split('/');
    const leafName = topicParts[topicParts.length - 1];
    
    const topicNode = page.locator('#chart-tree .node-name', { hasText: leafName }).first();
    await topicNode.waitFor({ state: 'visible', timeout: 5000 });
    await topicNode.click();

    // 5. Select the variable to chart
    // Wait for the variables list to populate
    const variableCheckbox = page.locator('.chart-variable-item input[type="checkbox"]').first();
    await variableCheckbox.waitFor({ state: 'visible', timeout: 5000 });
    
    // Checking the variable automatically triggers the chart generation via reactive state
    await variableCheckbox.check();

    // 6. Verify the Chart Canvas becomes visible
    const chartCanvas = page.locator('#chart-canvas');
    await expect(chartCanvas).toBeVisible({ timeout: 5000 });
    
    // The placeholder should be hidden
    const placeholder = page.locator('#chart-placeholder');
    await expect(placeholder).toBeHidden();

    // 7. Save the Chart Configuration
    const chartName = `E2E Test Chart ${Date.now()}`;
    
    // Handle the native prompt dialog that appears for "Save As New..."
    page.on('dialog', async dialog => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept(chartName);
    });

    await page.click('#btn-chart-save-as');

    // 8. Verify the configuration was saved and is now selected
    const toast = page.locator('.korelate-toast.success');
    await expect(toast).toContainText('Saved!', { timeout: 5000 });
    
    // Check if the dropdown contains and has selected the new chart name
    const selectedOption = await page.locator('#chart-config-select option:checked').textContent();
    expect(selectedOption).toBe(chartName);
  });
});