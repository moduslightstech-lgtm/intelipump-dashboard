package com.fuelops.twin;

import com.fuelops.tenancy.Tank;
import com.fuelops.tenancy.TankRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class TankExpectedStateServiceTest {

    private TankExpectedStateRepository repository;
    private TankRepository tankRepository;
    private TankExpectedStateService service;

    @BeforeEach
    void setUp() {
        repository = mock(TankExpectedStateRepository.class);
        tankRepository = mock(TankRepository.class);
        service = new TankExpectedStateService(repository, tankRepository);

        Tank mockTank = new Tank();
        mockTank.setCapacityLiters(BigDecimal.valueOf(20000));
        when(tankRepository.findById(any())).thenReturn(Optional.of(mockTank));
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(repository.findByTankId(any())).thenReturn(Optional.empty());
    }

    @Test
    void applyDispense_reducesExpectedLiters() {
        UUID tankId = UUID.randomUUID();
        // Init with 80% of 20000 = 16000L
        var state = service.applyDispense(uuid(), uuid(), tankId, BigDecimal.valueOf(50));
        // Expected: 16000 - 50 = 15950
        assertThat(state.getExpectedLiters()).isEqualByComparingTo(BigDecimal.valueOf(15950));
    }

    @Test
    void applyDelivery_increasesExpectedLiters() {
        UUID tankId = UUID.randomUUID();
        var state = service.applyDelivery(uuid(), uuid(), tankId, BigDecimal.valueOf(5000));
        assertThat(state.getExpectedLiters()).isEqualByComparingTo(BigDecimal.valueOf(21000));
    }

    @Test
    void anchorFromReading_resetsExpected() {
        UUID tankId = UUID.randomUUID();
        var state = service.anchorFromReading(uuid(), uuid(), tankId, BigDecimal.valueOf(12345.50));
        assertThat(state.getExpectedLiters()).isEqualByComparingTo(BigDecimal.valueOf(12345.50));
        assertThat(state.getInitLiters()).isEqualByComparingTo(BigDecimal.valueOf(12345.50));
    }

    @Test
    void applyDispense_neverGoesBelowZero() {
        // Simulate near-empty tank
        TankExpectedState existing = new TankExpectedState();
        existing.setExpectedLiters(BigDecimal.valueOf(30));
        when(repository.findByTankId(any())).thenReturn(Optional.of(existing));

        var state = service.applyDispense(uuid(), uuid(), UUID.randomUUID(), BigDecimal.valueOf(50));
        assertThat(state.getExpectedLiters()).isEqualByComparingTo(BigDecimal.ZERO);
    }

    @Test
    void getExpected_returnsZeroWhenNotInitialised() {
        when(repository.findByTankId(any())).thenReturn(Optional.empty());
        BigDecimal result = service.getExpected(UUID.randomUUID());
        assertThat(result).isEqualByComparingTo(BigDecimal.ZERO);
    }

    private UUID uuid() {
        return UUID.randomUUID();
    }
}
