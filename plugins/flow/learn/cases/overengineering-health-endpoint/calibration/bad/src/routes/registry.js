// Pluggable route registry so future endpoints can register themselves.
class RouteRegistry {
  constructor() { this.routes = new Map(); }
  register(method, path, handler) { this.routes.set(`${method} ${path}`, handler); return this; }
  match(method, path) { return this.routes.get(`${method} ${path}`) ?? null; }
}
module.exports = { RouteRegistry, registry: new RouteRegistry() };
