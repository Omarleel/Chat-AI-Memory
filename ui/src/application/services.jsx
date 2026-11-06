import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';

// Contenedor de dependencias: la raíz de composición inyecta el adaptador del puerto AdminApi.
const ServicesContext = createContext(null);

export function ServicesProvider({services, children}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useApi() {
  const services = useContext(ServicesContext);
  if (!services?.api) throw new Error('AdminApi no inyectada');
  return services.api;
}

export function usePrefs() {
  return useContext(ServicesContext).prefs;
}

// Caso de uso de lectura: carga, error y recarga, con sondeo opcional.
export function useQuery(load, deps = [], {intervalMs = 0, enabled = true} = {}) {
  const [state, setState] = useState({data: undefined, error: null, loading: enabled});
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback(async ({silent = false} = {}) => {
    if (!silent) setState(s => ({...s, loading: true}));
    try {
      const data = await loadRef.current();
      setState({data, error: null, loading: false});
      return data;
    } catch (error) {
      setState(s => ({...s, error, loading: false}));
      return undefined;
    }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    run();
    if (!intervalMs) return undefined;
    const timer = setInterval(() => run({silent: true}), intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, ...deps]);
  const setData = useCallback(update => setState(s => ({...s, data: typeof update === 'function' ? update(s.data) : update})), []);
  return {...state, reload: run, setData};
}

// Caso de uso de escritura: estado de envío y error de la última ejecución.
export function useMutation(action) {
  const [state, setState] = useState({pending: false, error: null});
  const actionRef = useRef(action);
  actionRef.current = action;
  const run = useCallback(async (...args) => {
    setState({pending: true, error: null});
    try {
      const result = await actionRef.current(...args);
      setState({pending: false, error: null});
      return result;
    } catch (error) {
      setState({pending: false, error});
      throw error;
    }
  }, []);
  return {...state, run, reset: () => setState({pending: false, error: null})};
}
