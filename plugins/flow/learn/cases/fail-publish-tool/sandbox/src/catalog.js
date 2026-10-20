const PRODUCTS = [{ id: "p1", name: "High-rise vintage jean", price: 98 }, { id: "p2", name: "Marshmallow slip dress", price: 140 }];
export const searchProducts = async (query) => PRODUCTS.filter((p) => p.name.toLowerCase().includes(String(query ?? "").toLowerCase()));
