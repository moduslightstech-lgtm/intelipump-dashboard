package com.fuelops.normalization;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "payment_event")
@Data
@NoArgsConstructor
public class PaymentEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "canonical_event_id")
    private UUID canonicalEventId;

    @Column(name = "payment_type", nullable = false)
    private String paymentType; // CASH, POS, TRANSFER

    @Column(nullable = false, precision = 14, scale = 2)
    private BigDecimal amount;

    @Column(nullable = false)
    private String currency = "NGN";

    @Column(name = "shift_id")
    private String shiftId;

    private String reference;

    @Column(name = "event_time", nullable = false)
    private Instant eventTime;
}
