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
  createSessionClient(): ApiClient;
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

function useSessionLifecycle(mountedRef: { current: boolean }, setState: SetAuthState) {
  const epochRef = useRef(0);
  const sessionActiveRef = useRef(false);
  const [sessionVersion, setSessionVersion] = useState(0);

  const establishSession = useCallback(
    (principal: Principal) => {
      epochRef.current += 1;
      sessionActiveRef.current = true;
      setSessionVersion(epochRef.current);
      setState({ status: "authenticated", principal, error: null, logoutError: null });
    },
    [setState],
  );

  const clearSession = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    if (sessionActiveRef.current) {
      epochRef.current += 1;
      setSessionVersion(epochRef.current);
    }
    sessionActiveRef.current = false;
    setState(cleanUnauthenticatedState());
  }, [mountedRef, setState]);

  const createSessionClient = useCallback(() => {
    const epoch = sessionVersion;
    return createApiClient({
      onUnauthorized: (signal) => {
        if (
          signal?.aborted ||
          !mountedRef.current ||
          !sessionActiveRef.current ||
          epoch !== epochRef.current
        ) {
          return;
        }

        clearSession();
      },
    });
  }, [clearSession, mountedRef, sessionVersion]);

  return { clearSession, createSessionClient, establishSession };
}

function useApiClient(
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  clearSession: () => void,
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
        clearSession();
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
  establishSession: (principal: Principal) => void,
) {
  useEffect(() => {
    const operation = startOperation(operationRef, "session");

    void apiClient
      .getMe({ signal: operation.controller.signal })
      .then((principal) => {
        if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
          return;
        }

        establishSession(principal);
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
  }, [apiClient, establishSession, mountedRef, operationRef, setState]);
}

function useLogin(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
  setState: SetAuthState,
  establishSession: (principal: Principal) => void,
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

        establishSession(principal);
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
    [apiClient, establishSession, mountedRef, operationRef, setState],
  );
}

function useServiceInfo(
  apiClient: ApiClient,
  mountedRef: { current: boolean },
  operationRef: AuthOperationRef,
) {
  return useCallback(
    async (callerSignal: AbortSignal): Promise<ServiceInfo | null> => {
      // An informational read must not supersede the user's session-ending mutation.
      if (operationRef.current?.kind === "logout") {
        return null;
      }
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
  clearSession: () => void,
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

      clearSession();
      return true;
    } catch (error) {
      if (!isCurrentOperation(mountedRef.current, operation, operationRef.current)) {
        return false;
      }

      if (operation.unauthorized) {
        clearSession();
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
  }, [apiClient, clearSession, mountedRef, operationRef, setState]);
}

export function AuthProvider({ children }: PropsWithChildren) {
  const mountedRef = useRef(false);
  const operationRef = useRef<AuthOperation | null>(null);
  const [state, setState] = useState<AuthState>(initialAuthState);
  const { clearSession, createSessionClient, establishSession } = useSessionLifecycle(
    mountedRef,
    setState,
  );
  const apiClient = useApiClient(mountedRef, operationRef, clearSession);

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

  useInitialSessionCheck(apiClient, mountedRef, operationRef, setState, establishSession);
  const login = useLogin(apiClient, mountedRef, operationRef, setState, establishSession);
  const loadServiceInfo = useServiceInfo(apiClient, mountedRef, operationRef);
  const logout = useLogout(apiClient, mountedRef, operationRef, setState, clearSession);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, createSessionClient, loadServiceInfo, login, logout }),
    [createSessionClient, loadServiceInfo, login, logout, state],
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
