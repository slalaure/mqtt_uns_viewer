/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 *
 * Service for managing chart configurations.
 * Handles API interactions and state for saved charts.
 */

class ChartConfigService {
    constructor() {
        this.allConfigs = { configurations: [] };
        this.currentConfigId = null;
    }

    /**
     * Loads all configurations from the backend.
     * Handles migration from legacy array format.
     */
    async loadConfigs() {
        try {
            const response = await fetch("api/chart/config");
            if (!response.ok) throw new Error("Failed to fetch chart config");
            let savedConfig = await response.json();
            
            if (Array.isArray(savedConfig)) {
                // Migration logic for old format
                this.allConfigs = {
                    configurations: [
                        {
                            id: `chart_${Date.now()}`,
                            name: "Migrated Chart",
                            chartType: "line",
                            connectNulls: false,
                            variables: savedConfig.map((v) => ({
                                sourceId: "default",
                                topic: v.topic,
                                path: v.path,
                            })),
                        },
                    ],
                };
                await this.saveAllConfigs();
            } else if (savedConfig && Array.isArray(savedConfig.configurations)) {
                this.allConfigs = savedConfig;
            } else {
                this.allConfigs = { configurations: [] };
            }
            return this.allConfigs;
        } catch (error) {
            console.error("[ChartConfigService] Load failed:", error);
            throw error;
        }
    }

    /**
     * Saves the current set of configurations to the backend.
     */
    async saveAllConfigs() {
        try {
            const response = await fetch("api/chart/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(this.allConfigs),
            });
            if (!response.ok) throw new Error("Failed to save");
            return true;
        } catch (error) {
            console.error("[ChartConfigService] Save failed:", error);
            throw error;
        }
    }

    /**
     * Returns a configuration by ID.
     */
    getConfig(id) {
        return this.allConfigs.configurations.find(c => c.id === id);
    }

    /**
     * Adds a new configuration and saves.
     */
    async addConfig(config) {
        this.allConfigs.configurations.push(config);
        return await this.saveAllConfigs();
    }

    /**
     * Updates an existing configuration and saves.
     */
    async updateConfig(id, updatedConfig) {
        const index = this.allConfigs.configurations.findIndex(c => c.id === id);
        if (index !== -1) {
            this.allConfigs.configurations[index] = { ...this.allConfigs.configurations[index], ...updatedConfig };
            return await this.saveAllConfigs();
        }
        return false;
    }

    /**
     * Deletes a configuration and saves.
     */
    async deleteConfig(id) {
        this.allConfigs.configurations = this.allConfigs.configurations.filter(c => c.id !== id);
        return await this.saveAllConfigs();
    }

    /**
     * Returns the list of configurations.
     */
    getConfigurations() {
        return this.allConfigs.configurations;
    }
}

export const chartConfigService = new ChartConfigService();
