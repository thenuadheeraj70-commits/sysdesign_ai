import { createContext, useContext, useEffect, useState } from "react";
import { getCatalog } from "./api/client.js";
import { COMPONENT_TYPES, PROVIDERS } from "./layout.js";

/**
 * Component types and providers come from the backend (GET /api/catalog), so the UI never
 * drifts from what the server accepts. The lists in layout.js are only a fallback for
 * the moment before the answer arrives, or if the request fails.
 */
const CatalogContext = createContext({ types: COMPONENT_TYPES, providers: PROVIDERS });

export function CatalogProvider({ children }) {
  const [catalog, setCatalog] = useState({ types: COMPONENT_TYPES, providers: PROVIDERS });

  useEffect(() => {
    let cancelled = false;
    getCatalog()
      .then((c) => {
        if (!cancelled && c?.types?.length && c?.providers?.length) setCatalog(c);
      })
      .catch(() => {
        /* keep the fallback lists */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

export const useCatalog = () => useContext(CatalogContext);
