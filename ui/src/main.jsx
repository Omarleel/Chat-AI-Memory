import {StrictMode, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ServicesProvider} from './application/services.jsx';
import {createHttpAdminApi} from './infrastructure/http-admin-api.js';
import {prefs, tokenStore} from './infrastructure/token-store.js';
import {App} from './ui/App.jsx';
import './index.css';

// Raíz de composición: aquí se eligen los adaptadores concretos de los puertos.
function Root() {
  const [token, setToken] = useState(tokenStore.get);
  const [state, setState] = useState({checking: false, error: null});
  const logout = () => {tokenStore.clear(); setToken('');};
  const api = useMemo(() => createHttpAdminApi({getToken: () => tokenStore.get(), onUnauthorized: logout}), []);
  async function login(candidate) {
    tokenStore.set(candidate);
    setState({checking: true, error: null});
    try {await api.system(); setToken(candidate); setState({checking: false, error: null});}
    catch (error) {tokenStore.clear(); setState({checking: false, error});}
  }
  return (
    <ServicesProvider services={{api, prefs}}>
      <App session={{token, login, logout, ...state}} />
    </ServicesProvider>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Root /></StrictMode>);
