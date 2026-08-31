import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ApiClient,
  ApiError,
  createApiClient,
  type LoginCredentials,
  type Principal,
  REQUEST_FAILED_MESSAGE,
} from "../../lib/api.js";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type AuthState = {
  status: AuthStatus;
  principal: Principal | null;
  error: string | null;
};

type SetAuthState = Dispatch<SetStateAction<AuthState>>;

export type AuthContextValue = AuthState & {
  login(credentials: LoginCredentials): Promise<boolean>;
};

const initialAuthState: AuthState = {
  status: "loading",
  principal: null,
  error: null,
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function canUpdate(
  mounted: boolean,
  controller: AbortController,
  transition: number,
  currentTransition: number,
) {
  return mounted && !controller.signal.aborted && transition === currentTransition;
}

function unauthenticatedState(error: unknown): AuthState {
  return {
    status: "unauthenticated",
    principal: null,
    error: isApiError(error) ? error.message : REQUEST_FAILED_MESSAGE,
  };
}

function useApiClient(
  mountedRef: { current: boolean },
  transitionRef: { current: number },
  setState: SetAuthState,
) {
  const clientRef = useRef<ApiClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = createApiClient({
      onUnauthorized: () => {
        if (!mountedRef.current) {
          return;
        }

        transitionRef.current += 1;
        setState({ status: "unauthenticated", principal: null, error: null });
      },
    });
  }

  return clientRef.current;
}

function useInitialSessionCheck(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  transitionRef: { current: number },
  setState: SetAuthState,
) {
  useEffect(() => {
    const controller = new AbortController();
    const transition = ++transitionRef.current;

    void apiClient
      .getMe({ signal: controller.signal })
      .then((principal) => {
        if (!canUpdate(mountedRef.current, controller, transition, transitionRef.current)) {
          return;
        }

        setState({ status: "authenticated", principal, error: null });
      })
      .catch((error: unknown) => {
        if (!canUpdate(mountedRef.current, controller, transition, transitionRef.current)) {
          return;
        }

        setState((current) =>
          current.status === "authenticated" ? current : unauthenticatedState(error),
        );
      });

    return () => {
      controller.abort();
    };
  }, [apiClient, mountedRef, setState, transitionRef]);
}

function useLogin(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  transitionRef: { current: number },
  setState: SetAuthState,
) {
  const controllerRef = useRef<AbortController | null>(null);

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      if (controllerRef.current) {
        return false;
      }

      const controller = new AbortController();
      const transition = ++transitionRef.current;
      controllerRef.current = controller;
      setState((current) =>
        current.status === "authenticated"
          ? current
          : { status: "unauthenticated", principal: null, error: null },
      );

      try {
        const principal = await apiClient.login(credentials, { signal: controller.signal });
        if (!canUpdate(mountedRef.current, controller, transition, transitionRef.current)) {
          return false;
        }

        setState({ status: "authenticated", principal, error: null });
        return true;
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted) {
          return false;
        }

        setState((current) =>
          current.status === "authenticated" ? current : unauthenticatedState(error),
        );
        return false;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    },
    [apiClient, mountedRef, setState, transitionRef],
  );

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  return login;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const mountedRef = useRef(false);
  const transitionRef = useRef(0);
  const [state, setState] = useState<AuthState>(initialAuthState);
  const apiClient = useApiClient(mountedRef, transitionRef, setState);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      transitionRef.current += 1;
    };
  }, []);

  useInitialSessionCheck(apiClient, mountedRef, transitionRef, setState);
  const login = useLogin(apiClient, mountedRef, transitionRef, setState);

  const value = useMemo<AuthContextValue>(() => ({ ...state, login }), [login, state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return value;
}
