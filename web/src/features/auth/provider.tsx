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
  type ServiceInfo,
} from "../../lib/api.js";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";
type AuthOperationKind = "info" | "login" | "logout" | "session";

type AuthState = {
  status: AuthStatus;
  principal: Principal | null;
  error: string | null;
  logoutError: string | null;
};

type SetAuthState = Dispatch<SetStateAction<AuthState>>;

type AuthOperation = {
  controller: AbortController;
  kind: AuthOperationKind;
  removeCallerAbortListener?: () => void;
  unauthorized: boolean;
};

type AuthOperationRef = {
  current: AuthOperation | null;
};

export type AuthContextValue = AuthState & {
  loadServiceInfo(callerSignal: AbortSignal): Promise<ServiceInfo | null>;
  login(credentials: LoginCredentials): Promise<boolean>;
  logout(): Promise<boolean>;
};

const initialAuthState: AuthState = {
  status: "loading",
  principal: null,
  error: null,
  logoutError: null,
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

function removeCallerAbortListener(operation: AuthOperation) {
  operation.removeCallerAbortListener?.();
  delete operation.removeCallerAbortListener;
}

function startOperation(operationRef: AuthOperationRef, kind: AuthOperationKind): AuthOperation {
  const previousOperation = operationRef.current;
  previousOperation?.controller.abort();
  if (previousOperation) {
    removeCallerAbortListener(previousOperation);
  }

  const operation: AuthOperation = {
    controller: new AbortController(),
    kind,
    unauthorized: false,
  };
  operationRef.current = operation;
  return operation;
}

function finishOperation(operationRef: AuthOperationRef, operation: AuthOperation) {
  removeCallerAbortListener(operation);
  if (operationRef.current === operation) {
    operationRef.current = null;
  }
}

function cleanUnauthenticatedState(): AuthState {
  return {
    status: "unauthenticated",
    principal: null,
    error: null,
    logoutError: null,
  };
}

function unauthenticatedState(error: unknown): AuthState {
  return {
    status: "unauthenticated",
    principal: null,
    error: isApiError(error) ? error.message : REQUEST_FAILED_MESSAGE,
    logoutError: null,
  };
}

function errorMessage(error: unknown) {
  return isApiError(error) ? error.message : REQUEST_FAILED_MESSAGE;
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
        setState(cleanUnauthenticatedState());
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

        setState({ status: "authenticated", principal, error: null, logoutError: null });
      })
      .catch((error: unknown) => {
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return;
        }

        if (operation.unauthorized && !isRequestFailure(error)) {
          return;
        }

        setState((current) =>
          current.status === "authenticated" ? current : unauthenticatedState(error),
        );
      })
      .finally(() => finishOperation(operationRef, operation));

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
  return useCallback(
    async (credentials: LoginCredentials) => {
      if (operationRef.current?.kind === "login") {
        return false;
      }

      const operation = startOperation(operationRef, "login");
      setState((current) =>
        current.status === "authenticated"
          ? current
          : { status: "unauthenticated", principal: null, error: null, logoutError: null },
      );

      try {
        const principal = await apiClient.login(credentials, {
          signal: operation.controller.signal,
        });
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return false;
        }

        setState({ status: "authenticated", principal, error: null, logoutError: null });
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
        finishOperation(operationRef, operation);
      }
    },
    [apiClient, mountedRef, operationRef, setState],
  );
}

function useServiceInfo(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
) {
  return useCallback(
    async (callerSignal: AbortSignal): Promise<ServiceInfo | null> => {
      const operation = startOperation(operationRef, "info");
      const abortOperation = () => operation.controller.abort();

      if (callerSignal.aborted) {
        abortOperation();
        finishOperation(operationRef, operation);
        return null;
      }

      callerSignal.addEventListener("abort", abortOperation, { once: true });
      operation.removeCallerAbortListener = () =>
        callerSignal.removeEventListener("abort", abortOperation);
      return apiClient
        .getInfo({ signal: operation.controller.signal })
        .then((serviceInfo) =>
          isCurrentOperation(mountedRef.current, operation, operationRef.current)
            ? serviceInfo
            : null,
        )
        .catch((error: unknown) => {
          if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
            return null;
          }

          return operation.unauthorized ? null : Promise.reject(error);
        })
        .finally(() => finishOperation(operationRef, operation));
    },
    [apiClient, mountedRef, operationRef],
  );
}

function useLogout(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  setState: SetAuthState,
) {
  return useCallback(async () => {
    if (operationRef.current?.kind === "logout") {
      return false;
    }

    const operation = startOperation(operationRef, "logout");
    setState((current) =>
      current.status === "authenticated" ? { ...current, error: null, logoutError: null } : current,
    );

    try {
      await apiClient.logout({ signal: operation.controller.signal });
      if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
        return false;
      }

      setState(cleanUnauthenticatedState());
      return true;
    } catch (error) {
      if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
        return false;
      }

      if (operation.unauthorized) {
        setState(cleanUnauthenticatedState());
        return true;
      }

      setState((current) =>
        current.status === "authenticated"
          ? { ...current, error: null, logoutError: errorMessage(error) }
          : current,
      );
      return false;
    } finally {
      finishOperation(operationRef, operation);
    }
  }, [apiClient, mountedRef, operationRef, setState]);
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
      if (operationRef.current) {
        removeCallerAbortListener(operationRef.current);
      }
      operationRef.current = null;
    };
  }, []);

  useInitialSessionCheck(apiClient, mountedRef, operationRef, setState);
  const login = useLogin(apiClient, mountedRef, operationRef, setState);
  const loadServiceInfo = useServiceInfo(apiClient, mountedRef, operationRef);
  const logout = useLogout(apiClient, mountedRef, operationRef, setState);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, loadServiceInfo, login, logout }),
    [loadServiceInfo, login, logout, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return value;
}
