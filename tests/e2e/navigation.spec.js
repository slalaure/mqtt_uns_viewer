const { test, expect } = require('@playwright/test');

test.describe('Navigation and Layout', () => {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';

  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    
    // Wait for the dynamic login form to be injected
    await page.waitForSelector('#login-username');
    
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    
    // Wait for the Tree View specifically to ensure DOM is fully hydrated
    await expect(page.locator('#btn-tree-view')).toHaveClass(/active/, { timeout: 10000 });
    
    // Crucial fix: Wait for the main container to be visible and stable
    await page.waitForSelector('.tree-controls', { state: 'visible' });
    
    // Add a tiny explicit wait to ensure event listeners in finishInitialization() are fully bound
    await page.waitForTimeout(500); 
  });

  test('should load the default layout successfully', async ({ page }) => {
    await expect(page.locator('#btn-tree-view')).toHaveClass(/active/);
    await expect(page.locator('main#tree-view')).toHaveClass(/active/);
    
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('nav.tab-nav')).toBeVisible();
    await expect(page.locator('footer.app-footer')).toBeVisible();
  });

  test('should navigate through main tabs correctly', async ({ page }) => {
    const tabs = [
      { btn: '#btn-hmi-view', panel: 'main#hmi-view' },
      { btn: '#btn-history-view', panel: 'main#history-view' },
      { btn: '#btn-mapper-view', panel: 'main#mapper-view' },
      { btn: '#btn-chart-view', panel: 'main#chart-view' },
      { btn: '#btn-alerts-view', panel: 'main#alerts-view' },
      { btn: '#btn-publish-view', panel: 'main#publish-view' },
      { btn: '#btn-tree-view', panel: 'main#tree-view' }
    ];

    for (const tab of tabs) {
      // Ensure the button is fully attached and ready to receive clicks
      const btn = page.locator(tab.btn);
      
      // Click the button, forcing it if it thinks it's intercepted
      await btn.click({ force: true });
      
      // Ensure the button has the active class
      await expect(btn).toHaveClass(/active/, { timeout: 5000 });
      // Ensure the panel has the active class
      await expect(page.locator(tab.panel)).toHaveClass(/active/);
    }
  });

  test('should toggle dark mode correctly', async ({ page }) => {
    const body = page.locator('body');
    // Target the visible label/slider instead of the hidden checkbox input
    const toggleLabel = page.locator('label.theme-switch');

    const isInitiallyDark = await body.evaluate(el => el.classList.contains('dark-mode'));
    
    // Click the visual slider to trigger the hidden checkbox
    await toggleLabel.click();
    
    if (isInitiallyDark) {
      await expect(body).not.toHaveClass(/dark-mode/);
    } else {
      await expect(body).toHaveClass(/dark-mode/);
    }

    // Toggle back
    await toggleLabel.click();
    
    if (isInitiallyDark) {
      await expect(body).toHaveClass(/dark-mode/);
    } else {
      await expect(body).not.toHaveClass(/dark-mode/);
    }
  });
});
