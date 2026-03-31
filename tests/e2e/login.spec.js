const { test, expect } = require('@playwright/test');

test.describe('Authentication Flow', () => {
  test('should redirect to login page when not authenticated', async ({ page }) => {
    await page.goto('/');
    // Check if we are redirected to /login
    await expect(page).toHaveURL(/.*login/);
  });

  test('should show login form', async ({ page }) => {
    await page.goto('/login');
    // Wait for the dynamic form to be injected
    await page.waitForSelector('#login-form');
    
    await expect(page.locator('#form-title')).toContainText('Sign In');
    await expect(page.locator('#login-username')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
  });

  test('should fail with incorrect credentials', async ({ page }) => {
    await page.goto('/login');
    await page.waitForSelector('#login-form');
    
    await page.fill('#login-username', 'wronguser');
    await page.fill('#login-password', 'wrongpass');
    await page.click('#login-form button[type="submit"]');
    
    // Check if an error message appears
    const errorMsg = page.locator('#login-error');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).not.toBeEmpty();
  });

  // Note: Testing successful login would require a known user in the DB.
  // We can use the admin account configured in .env
});
