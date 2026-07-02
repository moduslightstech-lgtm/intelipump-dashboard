import { useReducer, useEffect, useRef } from 'react';
import { initialTwinState, twinReducer, TwinAction } from '../lib/twinState';
import { TwinMqttClient } from '../lib/mqttClient';

export function useMqttTwin(enableDemo: boolean = false, brokerUrl?: string) {
    const [state, dispatch] = useReducer(twinReducer, initialTwinState);
    const clientRef = useRef<TwinMqttClient | null>(null);

    useEffect(() => {
        const client = new TwinMqttClient({
            brokerUrl,
            enableDemoMode: enableDemo,
            onMessage: (action: TwinAction) => {
                dispatch(action);
            }
        });

        client.connect();
        clientRef.current = client;

        return () => {
            client.disconnect();
        };
    }, [enableDemo, brokerUrl]);

    // Expose imperative commands if UI needs local interactions
    const pushAction = (action: TwinAction) => {
        dispatch(action);
    };

    return { state, pushAction };
}
