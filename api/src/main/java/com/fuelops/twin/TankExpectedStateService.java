package com.fuelops.twin;

import com.fuelops.tenancy.Tank;
import com.fuelops.tenancy.TankRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Optional;
import java.util.UUID;

/**
 * Maintains per-tank expected liters using an incremental delta model.
 * On DISPENSE: expectedLiters -= liters
 * On DELIVERY: expectedLiters += liters
 * On TANK_READING (init): expectedLiters = reportedLiters (reset anchor)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class TankExpectedStateService {

    private final TankExpectedStateRepository repository;
    private final TankRepository tankRepository;

    @Transactional
    public TankExpectedState getOrInit(UUID tenantId, UUID stationId, UUID tankId) {
        return repository.findByTankId(tankId).orElseGet(() -> {
            Tank tank = tankRepository.findById(tankId).orElse(null);
            TankExpectedState s = new TankExpectedState();
            s.setTenantId(tenantId);
            s.setStationId(stationId);
            s.setTankId(tankId);
            // Default init to 80% of capacity if no reading yet
            BigDecimal capacity = tank != null ? tank.getCapacityLiters() : BigDecimal.valueOf(20000);
            BigDecimal initVol = capacity.multiply(BigDecimal.valueOf(0.8)).setScale(2, RoundingMode.HALF_UP);
            s.setExpectedLiters(initVol);
            s.setInitLiters(initVol);
            log.info("Initialising expected state for tank {} at {}L", tankId, initVol);
            return repository.save(s);
        });
    }

    @Transactional
    public TankExpectedState applyDispense(UUID tenantId, UUID stationId, UUID tankId, BigDecimal liters) {
        TankExpectedState state = getOrInit(tenantId, stationId, tankId);
        BigDecimal updated = state.getExpectedLiters().subtract(liters).max(BigDecimal.ZERO);
        state.setExpectedLiters(updated.setScale(2, RoundingMode.HALF_UP));
        log.debug("Tank {} expected: {} - {} = {}", tankId, state.getExpectedLiters().add(liters), liters, updated);
        return repository.save(state);
    }

    @Transactional
    public TankExpectedState applyDelivery(UUID tenantId, UUID stationId, UUID tankId, BigDecimal liters) {
        TankExpectedState state = getOrInit(tenantId, stationId, tankId);
        BigDecimal updated = state.getExpectedLiters().add(liters);
        state.setExpectedLiters(updated.setScale(2, RoundingMode.HALF_UP));
        return repository.save(state);
    }

    /**
     * Called when a TANK_READING arrives — re-anchors expected = reported.
     * This prevents long drift accumulation.
     */
    @Transactional
    public TankExpectedState anchorFromReading(UUID tenantId, UUID stationId, UUID tankId, BigDecimal reportedLiters) {
        TankExpectedState state = getOrInit(tenantId, stationId, tankId);
        state.setExpectedLiters(reportedLiters.setScale(2, RoundingMode.HALF_UP));
        state.setInitLiters(reportedLiters.setScale(2, RoundingMode.HALF_UP));
        return repository.save(state);
    }

    public BigDecimal getExpected(UUID tankId) {
        return repository.findByTankId(tankId)
                .map(TankExpectedState::getExpectedLiters)
                .orElse(BigDecimal.ZERO);
    }
}
