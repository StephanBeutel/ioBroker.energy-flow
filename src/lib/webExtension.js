/**
 * Web extension for the ioBroker web adapter.
 * Serves the dashboard static files and provides a JSON API endpoint.
 *
 * The web adapter calls init(webserver, adapter, instanceSettings) on startup.
 */

const path = require("path");
const fs = require("fs");

/**
 * @param {object} webserver - express app
 * @param {object} adapter - adapter instance
 * @param {object} _instanceSettings - instance settings
 */
function init(webserver, adapter) {
    const wwwDir = path.join(__dirname, "..", "www");

    // Serve dashboard at /energy-flow/
    webserver.get("/energy-flow/*", (req, res) => {
        // Sanitize path to prevent directory traversal
        const reqPath = req.path.replace(/^\/energy-flow\/?/, "") || "index.html";
        const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
        const filePath = path.join(wwwDir, safePath);

        // Ensure the resolved path stays within wwwDir
        if (!filePath.startsWith(wwwDir)) {
            res.status(403).end();
            return;
        }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.sendFile(filePath);
        } else {
            res.sendFile(path.join(wwwDir, "index.html"));
        }
    });

    // JSON API endpoint for snapshot data
    webserver.get("/energy-flow/api/snapshot", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache");

        // Delegate to adapter via sendTo pattern
        adapter.sendTo(`energy-flow.${adapter.instance}`, "getSnapshot", {}, (result) => {
            if (result) {
                res.json(result);
            } else {
                res.status(503).json({ error: "No data available" });
            }
        });
    });

    adapter.log.info("Energy Flow web extension initialized");
}

module.exports = { init };
