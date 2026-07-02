export type TankState = {
    id: string;
    productType: "PMS" | "AGO";
    reported: number;
    expected: number;
    capacity: number;
    status: "idle" | "filling" | "dispensing" | "alert";
};

export type PumpStateInfo = {
    id: string;
    state: "IDLE" | "ACTIVE" | "WARNING" | "ERROR";
    liveValue: number;
    active: boolean;
};

export type PipeState = {
    id: string;
    active: boolean;
    flowDirection: 1 | -1;
    alertState: boolean;
};

export type TwinAlert = {
    targetId: string;
    severity: "warning" | "critical";
    message: string;
    timestamp: number;
};

export type TwinState = {
    tanks: Record<string, TankState>;
    pumps: Record<string, PumpStateInfo>;
    pipes: Record<string, PipeState>;
    alerts: TwinAlert[];
};

export const initialTwinState: TwinState = {
    tanks: {
        "T1": { id: "T1", productType: "PMS", reported: 20000, expected: 20000, capacity: 45000, status: "idle" },
        "T2": { id: "T2", productType: "AGO", reported: 15000, expected: 15000, capacity: 40000, status: "idle" }
    },
    pumps: {
        "P1": { id: "P1", state: "IDLE", liveValue: 0, active: false },
        "P2": { id: "P2", state: "IDLE", liveValue: 0, active: false },
        "P3": { id: "P3", state: "IDLE", liveValue: 0, active: false },
        "P4": { id: "P4", state: "IDLE", liveValue: 0, active: false },
    },
    pipes: {
        "1": { id: "1", active: false, flowDirection: 1, alertState: false },
        "2": { id: "2", active: false, flowDirection: 1, alertState: false },
        "3": { id: "3", active: false, flowDirection: 1, alertState: false },
        "4": { id: "4", active: false, flowDirection: 1, alertState: false },
    },
    alerts: []
};

export type TwinAction = 
    | { type: "TANK_READING"; payload: { tankId: string; reported: number; expected: number } }
    | { type: "DISPENSE"; payload: { tankId: string; pumpId: string; amount: number; pathPipeIds: string[] } }
    | { type: "DISPENSE_STOP"; payload: { pumpId: string; pathPipeIds: string[] } }
    | { type: "ALERT"; payload: { targetId: string; severity: "warning" | "critical"; message: string } }
    | { type: "LEAK"; payload: { tankId: string; pipeId: string; severity: "critical" } }
    | { type: "CLEAR_ALERTS" };

export function twinReducer(state: TwinState, action: TwinAction): TwinState {
    switch (action.type) {
        case "TANK_READING": {
            const tk = state.tanks[action.payload.tankId];
            if (!tk) return state;
            return {
                ...state,
                tanks: {
                    ...state.tanks,
                    [action.payload.tankId]: { ...tk, reported: action.payload.reported, expected: action.payload.expected }
                }
            };
        }
        case "DISPENSE": {
            const { pumpId, amount, pathPipeIds } = action.payload;
            const updatedPipes = { ...state.pipes };
            pathPipeIds.forEach(id => {
                if (updatedPipes[id]) updatedPipes[id] = { ...updatedPipes[id], active: true };
            });
            return {
                ...state,
                pumps: {
                    ...state.pumps,
                    [pumpId]: { ...state.pumps[pumpId], state: "ACTIVE", active: true, liveValue: amount }
                },
                pipes: updatedPipes
            };
        }
        case "DISPENSE_STOP": {
             const { pumpId, pathPipeIds } = action.payload;
             const updatedPipes = { ...state.pipes };
             pathPipeIds.forEach(id => {
                 if (updatedPipes[id]) updatedPipes[id] = { ...updatedPipes[id], active: false };
             });
             return {
                 ...state,
                 pumps: {
                     ...state.pumps,
                     [pumpId]: { ...state.pumps[pumpId], state: "IDLE", active: false }
                 },
                 pipes: updatedPipes
             };
        }
        case "ALERT": {
            return {
                ...state,
                alerts: [{ ...action.payload, timestamp: Date.now() }, ...state.alerts]
            };
        }
        case "LEAK": {
             return {
                ...state,
                alerts: [{ targetId: action.payload.pipeId, severity: action.payload.severity, message: "LEAK DETECTED", timestamp: Date.now() }, ...state.alerts]
            };
        }
        case "CLEAR_ALERTS":
            return { ...state, alerts: [] };
        default:
            return state;
    }
}
