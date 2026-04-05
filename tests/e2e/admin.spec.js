const { test, expect } = require('@playwright/test');

test.describe('Admin Panel & Webhooks', () => {
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

    // Ensure we start with a clean state by clearing all webhooks
    await page.click('#btn-admin-view');
    await page.click('button.sub-tab-button:has-text("Webhooks")');
    const clearButton = page.locator('#btn-webhooks-clear');
    if (await clearButton.isVisible()) {
        await clearButton.click();
        await page.click('#confirm-modal-ok');
        // Wait for table to be empty or show "No webhooks registered"
        await expect(page.locator('#admin-webhooks-table-body')).toContainText('No webhooks registered');
    }
  });

  test('should register, test and delete a webhook', async ({ page }) => {
    // 1. Navigate to the Admin Tab
    await page.click('#btn-admin-view');
    await expect(page.locator('#admin-view')).toHaveClass(/active/);

    // 2. Click on the Webhooks sub-tab
    await page.click('button.sub-tab-button:has-text("Webhooks")');
    await expect(page.locator('#admin-webhooks-panel')).toBeVisible();

    // 3. Fill the registration form
    const topic = 'test/e2e/webhook';
    const url = 'http://localhost:9999/dummy-webhook';
    
    await page.fill('#webhook-topic', topic);
    await page.fill('#webhook-url', url);
    await page.fill('#webhook-interval', '500');

    // 4. Submit the form
    await page.click('#webhook-register-form button[type="submit"]');

    // 5. Verify the webhook appears in the table
    const tableBody = page.locator('#admin-webhooks-table-body');
    await expect(tableBody).toContainText(topic);
    await expect(tableBody).toContainText(url);

    // 6. Test the webhook
    // Find the row with our topic and click the Test button
    const row = tableBody.locator('tr', { hasText: topic });
    await row.locator('button.btn-test-webhook').click();

    // 7. Verify the toast message
    const toast = page.locator('.toast.toast-success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Test trigger sent');

    // 8. Delete the webhook
    await row.locator('button.btn-delete-webhook').click();
    
    // Handle the confirmation modal
    const confirmButton = page.locator('#confirm-modal-ok');
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();

    // 9. Verify it's gone from the table
    await expect(tableBody).not.toContainText(topic);
  });
});
