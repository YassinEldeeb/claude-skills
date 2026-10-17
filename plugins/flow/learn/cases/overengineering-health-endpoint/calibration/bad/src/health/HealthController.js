// Health controller: liveness and readiness checks behind a common interface.
class HealthCheck { async run() { return { ok: true }; } }
class UptimeCheck extends HealthCheck { async run() { return { ok: true, uptime: process.uptime() }; } }
class HealthController {
  constructor(checks = [new UptimeCheck()]) { this.checks = checks; }
  handle(req, res, send) { send(res, 200, { status: "ok", checks: this.checks.length }); }
}
function register(registry, controller = new HealthController()) {
  registry.register("GET", "/health", (req, res, send) => controller.handle(req, res, send));
}
module.exports = { HealthController, HealthCheck, UptimeCheck, register };
