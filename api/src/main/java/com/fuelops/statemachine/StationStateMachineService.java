package com.fuelops.statemachine;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Hand-rolled station state machine.
 *
 * States: ONLINE | DEGRADED | DATA_GAP | RECONCILING | ALERTING
 * Events: EVENT_RECEIVED | DATA_GAP_DETECTED | VARIANCE_WARN |
 * VARIANCE_CRITICAL | RECONCILIATION_STARTED | RECONCILIATION_COMPLETED
 *
 * Transition table:
 * * + DATA_GAP_DETECTED → DATA_GAP
 * * + VARIANCE_CRITICAL → ALERTING
 * * + VARIANCE_WARN → DEGRADED (unless already ALERTING)
 * * + RECONCILIATION_STARTED → RECONCILING
 * RECONCILING + RECON_COMPLETED → ONLINE
 * DATA_GAP + EVENT_RECEIVED → ONLINE
 * ONLINE + EVENT_RECEIVED → ONLINE (no-op, update timestamps)
 * DEGRADED + EVENT_RECEIVED → DEGRADED (no-op, timestamps)
 * ALERTING + EVENT_RECEIVED → ALERTING (no-op, timestamps)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class StationStateMachineService {

    public enum MachineEvent {
        EVENT_RECEIVED,
        DATA_GAP_DETECTED,
        VARIANCE_WARN,
        VARIANCE_CRITICAL,
        RECONCILIATION_STARTED,
        RECONCILIATION_COMPLETED
    }

    public enum EventKind {
        DISPENSE, TANK_READING, PAYMENT, RAW
    }

    private final StationRuntimeStateRepository repository;

    @Transactional
    public StationRuntimeState getOrInit(UUID tenantId, UUID stationId) {
        return repository.findByStationId(stationId).orElseGet(() -> {
            StationRuntimeState s = new StationRuntimeState();
            s.setTenantId(tenantId);
            s.setStationId(stationId);
            s.setState("ONLINE");
            s.setEnteredAt(Instant.now());
            s.setMetadata(Map.of("initAt", Instant.now().toString()));
            return repository.save(s);
        });
    }

    @Transactional
    public StationRuntimeState transition(UUID tenantId, UUID stationId,
            MachineEvent event, EventKind kind) {
        StationRuntimeState state = getOrInit(tenantId, stationId);
        String current = state.getState();
        String next = computeNext(current, event);

        if (!current.equals(next)) {
            log.info("Station {} state: {} → {} (event: {})", stationId, current, next, event);
            state.setState(next);
            state.setEnteredAt(Instant.now());
        }

        // Update freshness timestamps
        Instant now = Instant.now();
        state.setLastRawReceived(now);
        if (kind == EventKind.DISPENSE)
            state.setLastDispenseAt(now);
        else if (kind == EventKind.TANK_READING)
            state.setLastTankReadingAt(now);
        else if (kind == EventKind.PAYMENT)
            state.setLastPaymentAt(now);

        // Update metadata
        Map<String, Object> meta = new LinkedHashMap<>(state.getMetadata());
        meta.put("lastEvent", event.name());
        meta.put("lastEventAt", now.toString());
        state.setMetadata(meta);

        return repository.save(state);
    }

    private String computeNext(String current, MachineEvent event) {
        return switch (event) {
            case DATA_GAP_DETECTED -> "DATA_GAP";
            case VARIANCE_CRITICAL -> "ALERTING";
            case VARIANCE_WARN -> "ALERTING".equals(current) ? current : "DEGRADED";
            case RECONCILIATION_STARTED -> "RECONCILING";
            case RECONCILIATION_COMPLETED -> "ONLINE";
            case EVENT_RECEIVED -> "DATA_GAP".equals(current) ? "ONLINE" : current;
        };
    }

    public StationRuntimeState getState(UUID stationId) {
        return repository.findByStationId(stationId).orElse(null);
    }

    /** Called by the scheduled gap checker */
    @Transactional
    public void markDataGap(UUID tenantId, UUID stationId) {
        transition(tenantId, stationId, MachineEvent.DATA_GAP_DETECTED, EventKind.RAW);
    }
}
