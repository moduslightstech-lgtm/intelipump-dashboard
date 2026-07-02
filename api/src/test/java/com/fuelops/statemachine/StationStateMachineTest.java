package com.fuelops.statemachine;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class StationStateMachineTest {

    private StationRuntimeStateRepository repository;
    private StationStateMachineService service;

    @BeforeEach
    void setUp() {
        repository = mock(StationRuntimeStateRepository.class);
        service = new StationStateMachineService(repository);

        // Default: return empty so getOrInit creates new
        when(repository.findByStationId(any())).thenReturn(java.util.Optional.empty());
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    @Test
    void onlineReceivesEvent_staysOnline() {
        var state = service.transition(uuid(), uuid(),
                StationStateMachineService.MachineEvent.EVENT_RECEIVED,
                StationStateMachineService.EventKind.DISPENSE);
        assertThat(state.getState()).isEqualTo("ONLINE");
    }

    @Test
    void dataGapDetected_transitionsToDataGap() {
        var state = service.transition(uuid(), uuid(),
                StationStateMachineService.MachineEvent.DATA_GAP_DETECTED,
                StationStateMachineService.EventKind.RAW);
        assertThat(state.getState()).isEqualTo("DATA_GAP");
    }

    @Test
    void dataGapThenEventReceived_recoversToOnline() {
        UUID stationId = uuid();
        UUID tenantId = uuid();
        // Simulate current state = DATA_GAP
        StationRuntimeState existing = new StationRuntimeState();
        existing.setStationId(stationId);
        existing.setTenantId(tenantId);
        existing.setState("DATA_GAP");
        when(repository.findByStationId(stationId)).thenReturn(java.util.Optional.of(existing));

        var state = service.transition(tenantId, stationId,
                StationStateMachineService.MachineEvent.EVENT_RECEIVED,
                StationStateMachineService.EventKind.DISPENSE);
        assertThat(state.getState()).isEqualTo("ONLINE");
    }

    @Test
    void varianceCritical_transitionsToAlerting() {
        var state = service.transition(uuid(), uuid(),
                StationStateMachineService.MachineEvent.VARIANCE_CRITICAL,
                StationStateMachineService.EventKind.RAW);
        assertThat(state.getState()).isEqualTo("ALERTING");
    }

    @Test
    void varianceWarn_whenAlerting_staysAlerting() {
        UUID stationId = uuid();
        UUID tenantId = uuid();
        StationRuntimeState existing = new StationRuntimeState();
        existing.setStationId(stationId);
        existing.setTenantId(tenantId);
        existing.setState("ALERTING");
        when(repository.findByStationId(stationId)).thenReturn(java.util.Optional.of(existing));

        var state = service.transition(tenantId, stationId,
                StationStateMachineService.MachineEvent.VARIANCE_WARN,
                StationStateMachineService.EventKind.RAW);
        assertThat(state.getState()).isEqualTo("ALERTING"); // not downgraded to DEGRADED
    }

    private UUID uuid() {
        return UUID.randomUUID();
    }
}
