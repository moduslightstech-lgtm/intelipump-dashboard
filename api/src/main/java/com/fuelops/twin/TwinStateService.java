package com.fuelops.twin;

import com.fuelops.ingestion.RawEventRepository;
import com.fuelops.normalization.CanonicalEvent;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.statemachine.StationRuntimeState;
import com.fuelops.statemachine.StationRuntimeStateRepository;
import com.fuelops.tenancy.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class TwinStateService {

    private final StationStateSnapshotRepository snapshotRepository;
    private final TankRepository tankRepository;
    private final PumpRepository pumpRepository;
    private final NozzleRepository nozzleRepository;
    private final CanonicalEventRepository canonicalEventRepository;
    private final RawEventRepository rawEventRepository;
    private final TankExpectedStateService tankExpectedStateService;
    private final StationRuntimeStateRepository runtimeStateRepository;
    private final StationRepository stationRepository;

    @Transactional
    public StationStateSnapshot computeAndSave(UUID tenantId, UUID stationId) {
        StationStateSnapshot snapshot = snapshotRepository.findByStationId(stationId)
                .orElse(new StationStateSnapshot());
        snapshot.setTenantId(tenantId);
        snapshot.setStationId(stationId);
        snapshot.setTankStates(computeTankStates(tenantId, stationId));
        snapshot.setPumpStates(computePumpStates(stationId));
        snapshot.setLastEventTimes(computeLastEventTimes(stationId));
        snapshot.setSnapshotTime(Instant.now());
        return snapshotRepository.save(snapshot);
    }

    /**
     * Build a complete DTO for SSE broadcasting and REST responses.
     * Does NOT persist (fast path for live streaming).
     */
    public Map<String, Object> buildSnapshotDto(UUID tenantId, UUID stationId) {
        var station = stationRepository.findById(stationId);
        var runtimeState = runtimeStateRepository.findByStationId(stationId).orElse(null);

        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("stationId", stationId);
        dto.put("stationName", station.map(s -> s.getName()).orElse("Unknown"));
        dto.put("snapshotTime", Instant.now().toString());
        dto.put("state", runtimeState != null ? runtimeState.getState() : "ONLINE");
        dto.put("tankStates", computeTankStates(tenantId, stationId));
        dto.put("pumpStates", computePumpStates(stationId));
        
        Map<String, Object> eventTimes = computeLastEventTimes(stationId);
        dto.put("lastEventTimes", eventTimes);
        
        dto.put("lastDispenseAt", eventTimes.get("FUEL_DISPENSE"));
        dto.put("lastTankReadingAt", eventTimes.get("TANK_READING"));
        dto.put("lastPaymentAt", eventTimes.get("PAYMENT"));
        dto.put("lastRawReceived", eventTimes.get("lastRawReceived"));
        
        return dto;
    }

    private Map<String, Object> computeTankStates(UUID tenantId, UUID stationId) {
        Map<String, Object> tankStates = new LinkedHashMap<>();
        List<Tank> tanks = tankRepository.findByStationId(stationId);
        Instant dayStart = Instant.now().truncatedTo(ChronoUnit.DAYS);

        List<CanonicalEvent> readings = canonicalEventRepository
                .findByStationIdAndEventTypeAndEventTimeBetweenOrderByEventTimeAsc(
                        stationId, "TANK_READING", dayStart, Instant.now());

        for (Tank tank : tanks) {
            BigDecimal reportedLiters = BigDecimal.ZERO;

            // Find latest reported reading for this tank
            for (int i = readings.size() - 1; i >= 0; i--) {
                CanonicalEvent ev = readings.get(i);
                Object tankIdInEvent = ev.getData().get("tankId");
                if (tankIdInEvent != null && tank.getId().toString().equals(tankIdInEvent.toString())) {
                    Object lvl = ev.getData().get("reportedLiters");
                    if (lvl != null) {
                        reportedLiters = new BigDecimal(lvl.toString());
                    }
                    break;
                }
            }

            // Per-tank expected from incremental delta service
            BigDecimal expectedLiters = tankExpectedStateService.getExpected(tank.getId());
            if (expectedLiters.compareTo(BigDecimal.ZERO) == 0) {
                // Fall back to 80% capacity if not yet tracked
                expectedLiters = tank.getCapacityLiters().multiply(BigDecimal.valueOf(0.8));
                // Also init the state for future tracking
                tankExpectedStateService.getOrInit(tenantId, stationId, tank.getId());
            }

            BigDecimal deltaLiters = reportedLiters.subtract(expectedLiters).setScale(2, RoundingMode.HALF_UP);
            BigDecimal deltaPercent = expectedLiters.compareTo(BigDecimal.ZERO) == 0
                    ? BigDecimal.ZERO
                    : deltaLiters.divide(expectedLiters, 4, RoundingMode.HALF_UP)
                            .multiply(BigDecimal.valueOf(100)).setScale(2, RoundingMode.HALF_UP);

            BigDecimal fillPercent = tank.getCapacityLiters().compareTo(BigDecimal.ZERO) == 0
                    ? BigDecimal.ZERO
                    : reportedLiters.divide(tank.getCapacityLiters(), 4, RoundingMode.HALF_UP)
                            .multiply(BigDecimal.valueOf(100)).setScale(2, RoundingMode.HALF_UP);

            Map<String, Object> state = new LinkedHashMap<>();
            state.put("label", tank.getLabel());
            state.put("productId", tank.getProductId().toString());
            state.put("capacityLiters", tank.getCapacityLiters());
            state.put("reportedLiters", reportedLiters.setScale(2, RoundingMode.HALF_UP));
            state.put("expectedLiters", expectedLiters.setScale(2, RoundingMode.HALF_UP));
            state.put("deltaLiters", deltaLiters);
            state.put("deltaPercent", deltaPercent);
            state.put("fillPercent", fillPercent);

            tankStates.put(tank.getId().toString(), state);
        }
        return tankStates;
    }

    private Map<String, Object> computePumpStates(UUID stationId) {
        Map<String, Object> pumpStates = new LinkedHashMap<>();
        List<Pump> pumps = pumpRepository.findByStationId(stationId);
        Instant dayStart = Instant.now().truncatedTo(ChronoUnit.DAYS);

        List<CanonicalEvent> dispenses = canonicalEventRepository
                .findByStationIdAndEventTypeAndEventTimeBetweenOrderByEventTimeAsc(
                        stationId, "FUEL_DISPENSE", dayStart, Instant.now());

        for (Pump pump : pumps) {
            List<Nozzle> nozzles = nozzleRepository.findByPumpId(pump.getId());
            Set<String> nozzleIds = new HashSet<>();
            nozzles.forEach(n -> nozzleIds.add(n.getId().toString()));

            long txCount = 0;
            BigDecimal totalLiters = BigDecimal.ZERO;
            String lastNozzleId = null;
            for (CanonicalEvent ev : dispenses) {
                Object nozzleId = ev.getData().get("nozzleId");
                if (nozzleId != null && nozzleIds.contains(nozzleId.toString())) {
                    txCount++;
                    Object liters = ev.getData().get("liters");
                    if (liters != null)
                        totalLiters = totalLiters.add(new BigDecimal(liters.toString()));
                    lastNozzleId = nozzleId.toString();
                }
            }

            Map<String, Object> state = new LinkedHashMap<>();
            state.put("label", pump.getLabel());
            state.put("active", pump.isActive());
            state.put("transactionCount", txCount);
            state.put("totalLiters", totalLiters.setScale(2, RoundingMode.HALF_UP));
            state.put("nozzleCount", nozzles.size());
            state.put("lastNozzleId", lastNozzleId);

            pumpStates.put(pump.getId().toString(), state);
        }
        return pumpStates;
    }

    private Map<String, Object> computeLastEventTimes(UUID stationId) {
        Map<String, Object> times = new LinkedHashMap<>();
        for (String type : List.of("FUEL_DISPENSE", "TANK_READING", "PRICE_CHANGE", "PAYMENT")) {
            canonicalEventRepository.findLatestEventTimeByStationAndType(stationId, type)
                    .ifPresent(t -> times.put(type, t.toString()));
        }
        rawEventRepository.findLastReceivedTimeByStationId(stationId)
                .ifPresent(t -> times.put("lastRawReceived", t.toString()));
        return times;
    }

    private String nullStr(Instant t) {
        return t != null ? t.toString() : null;
    }
}
