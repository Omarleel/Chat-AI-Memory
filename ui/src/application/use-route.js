import {useEffect, useState} from 'react';

// Navegación por hash (#/vista?param=valor): funciona servida como archivos estáticos en /ui/.
function parse() {
  const [path, search = ''] = (window.location.hash.replace(/^#/, '') || '/panel').split('?');
  return {path: path || '/panel', params: Object.fromEntries(new URLSearchParams(search))};
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path, params = {}) {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  window.location.hash = `${path}${search ? `?${search}` : ''}`;
}
