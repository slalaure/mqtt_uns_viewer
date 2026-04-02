const { test, expect } = require('@playwright/test');

test.describe('HMI Asset Management Flow', () => {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const testFileName = `e2e_test_dashboard_${Date.now()}.html`;

  test.beforeEach(async ({ page }) => {
    // 1. Authenticate as Administrator
    await page.goto('/login');
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    
    // Wait for the tree view to be fully active indicating successful login
    await expect(page.locator('#btn-tree-view')).toHaveClass(/active/, { timeout: 10000 });
  });

  test('should upload, list, and delete an HMI HTML asset', async ({ page }) => {
    // 2. Navigate to Admin View -> HMI Assets tab
    await page.click('#btn-admin-view');
    await expect(page.locator('main#admin-view')).toHaveClass(/active/);
    
    const hmiTabBtn = page.locator('.sub-tab-button[data-target="admin-assets-panel"]');
    await hmiTabBtn.click();
    await expect(hmiTabBtn).toHaveClass(/active/);

    // 3. Prepare a dummy HTML file in memory and upload it
    const fileBuffer = Buffer.from('<!DOCTYPE html><html><body><h1>E2E Test HMI</h1></body></html>');
    
    await page.setInputFiles('#hmi-upload-input', {
      name: testFileName,
      mimeType: 'text/html',
      buffer: fileBuffer
    });

    await page.click('#btn-upload-hmi');

    // 4. Verify Upload Success Toast/Status
    const uploadStatus = page.locator('#hmi-upload-status');
    await expect(uploadStatus).toContainText('Successfully uploaded', { timeout: 5000 });

    // 5. Verify the file appears in the HMI Assets table
    const tableRow = page.locator('#admin-hmi-table-body tr', { hasText: testFileName });
    await expect(tableRow).toBeVisible();

    // 6. Automatically accept the confirmation modal for deletion
    // The application uses a custom custom confirmation modal, not a native dialog
    // We need to wait for the modal and click confirm
    
    await tableRow.locator('.btn-delete-asset').click();
    
    // Wait for the generic confirmation modal to appear
    const confirmModalBtn = page.locator('.generic-modal-actions .button-primary');
    await confirmModalBtn.waitFor({ state: 'visible' });
    await confirmModalBtn.click();

    // 7. Verify deletion success and absence from the table
    // A toast should appear
    const toast = page.locator('.korelate-toast.success');
    await expect(toast).toContainText('deleted successfully', { timeout: 5000 });
    
    // The row should no longer be in the table
    await expect(page.locator('#admin-hmi-table-body tr', { hasText: testFileName })).toHaveCount(0);
  });
});