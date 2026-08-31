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
type AuthOperationKind = "login" | "session";

type AuthState = {
  status: AuthStatus;
  principal: Principal | null;
  error: string | null;
};

type SetAuthState = Dispatch<SetStateAction<AuthState>>;

type AuthOperation = {
  controller: AbortController;
  kind: AuthOperationKind;
  unauthorized: boolean;
};

type AuthOperationRef = {
  current: AuthOperation | null;
};

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

function isCurrentOperation(
  mounted: boolean,
  operation: AuthOperation,
  currentOperation: AuthOperation | null,
) {
  return mounted && !operation.controller.signal.aborted && operation === currentOperation;
}

function startOperation(operationRef: AuthOperationRef, kind: AuthOperationKind): AuthOperation {
  operationRef.current?.controller.abort();

  const operation: AuthOperation = {
    controller: new AbortController(),
    kind,
    unauthorized: false,
  };
  operationRef.current = operation;
  return operation;
}

function unauthenticatedState(error: unknown): AuthState {
  return {
    status: "unauthenticated",
    principal: null,
    error: isApiError(error) ? error.message : REQUEST_FAILED_MESSAGE,
  };
}

function isRequestFailure(error: unknown) {
  return isApiError(error) && error.code === "request_failed";
}

function useApiClient(
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  setState: SetAuthState,
) {
  const clientRef = useRef<ApiClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = createApiClient({
      onUnauthorized: (signal) => {
        const operation = operationRef.current;
        if (
          !operation ||
          signal !== operation.controller.signal ||
          !isCurrentOperation(mountedRef.current, operation, operationRef.current)
        ) {
          return;
        }

        operation.unauthorized = true;
        setState({ status: "unauthenticated", principal: null, error: null });
      },
    });
  }

  return clientRef.current;
}

function useInitialSessionCheck(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  setState: SetAuthState,
) {
  useEffect(() => {
    const operation = startOperation(operationRef, "session");

    void apiClient
      .getMe({ signal: operation.controller.signal })
      .then((principal) => {
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return;
        }

        setState({ status: "authenticated", principal, error: null });
      })
      .catch((error: unknown) => {
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return;
        }

        if (operation.kind === "session" && operation.unauthorized && !isRequestFailure(error)) {
          return;
        }

        setState((current) =>
          current.status === "authenticated" ? current : unauthenticatedState(error),
        );
      });

    return () => {
      operation.controller.abort();
    };
  }, [apiClient, mountedRef, operationRef, setState]);
}

function useLogin(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  setState: SetAuthState,
) {
  const controllerRef = useRef<AbortController | null>(null);

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      if (controllerRef.current) {
        return false;
      }

      const operation = startOperation(operationRef, "login");
      controllerRef.current = operation.controller;
      setState((current) =>
        current.status === "authenticated"
          ? current
          : { status: "unauthenticated", principal: null, error: null },
      );

      try {
        const principal = await apiClient.login(credentials, {
          signal: operation.controller.signal,
        });
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return false;
        }

        setState({ status: "authenticated", principal, error: null });
        return true;
      } catch (error) {
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return false;
        }

        if (operation.unauthorized) {
          setState(unauthenticatedState(error));
          return false;
        }

        setState((current) =>
          current.status === "authenticated" ? current : unauthenticatedState(error),
        );
        return false;
      } finally {
        if (controllerRef.current === operation.controller) {
          controllerRef.current = null;
        }
      }
    },
    [apiClient, mountedRef, operationRef, setState],
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
  const operationRef = useRef<AuthOperation | null>(null);
  const [state, setState] = useState<AuthState>(initialAuthState);
  const apiClient = useApiClient(mountedRef, operationRef, setState);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      operationRef.current = null;
    };
  }, []);

  useInitialSessionCheck(apiClient, mountedRef, operationRef, setState);
  const login = useLogin(apiClient, mountedRef, operationRef, setState);

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
