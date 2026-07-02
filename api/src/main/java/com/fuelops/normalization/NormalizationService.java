package com.fuelops.normalization;

import com.fuelops.ingestion.RawEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import com.fuelops.sse.SseEmitterRegistry;
import com.fuelops.tenancy.Nozzle;
import com.fuelops.tenancy.NozzleRepository;
import com.fuelops.tenancy.Tank;
import com.fuelops.tenancy.TankRepository;
import com.fuelops.twin.TankExpectedStateService;
import com.fuelops.twin.TwinStateService;

@Service
@RequiredArgsConstructor
@Slf4j
public class NormalizationService {

    private final CanonicalEventRepository canonicalEventRepository;
    private final TankExpectedStateService tankExpectedStateService;
    private final TwinStateService twinStateService;
    private final SseEmitterRegistry sseEmitterRegistry;
    private final NozzleRepository nozzleRepository;
    private final TankRepository tankRepository;

    @Transactional
    public void normalize(RawEvent raw) {
        try {
            CanonicalEvent canonical = new CanonicalEvent();
            canonical.setRawEventId(raw.getId());
            canonical.setTenantId(raw.getTenantId());
            canonical.setStationId(raw.getStationId());
            canonical.setEventTime(raw.getDeviceTime() != null ? raw.getDeviceTime() : raw.getReceivedTime());

            Map<String, Object> data = normalizePayload(raw);
            if (data == null) {
                log.debug("Skipping normalization for unrecognized event type: {}", raw.getEventType());
                return;
            }

            canonical.setEventType(mapEventType(raw.getEventType()));
            canonical.setData(data);
            canonicalEventRepository.save(canonical);

            if ("FUEL_DISPENSE".equals(canonical.getEventType())) {
                Object tIdObj = canonical.getData().get("tankId");
                UUID tankId = null;
                if (tIdObj != null) {
                    try { tankId = UUID.fromString(tIdObj.toString()); } catch (Exception ignored) {}
                }
                if (tankId == null) {
                    Object nozzleIdObj = canonical.getData().get("nozzleId");
                    if (nozzleIdObj != null) {
                        try {
                            UUID nozzleId = UUID.fromString(nozzleIdObj.toString());
                            Nozzle nozzle = nozzleRepository.findById(nozzleId).orElse(null);
                            if (nozzle != null) {
                                Tank tank = tankRepository.findByStationId(canonical.getStationId()).stream()
                                        .filter(t -> t.getProductId().equals(nozzle.getProductId()))
                                        .findFirst().orElse(null);
                                if (tank != null) tankId = tank.getId();
                            }
                        } catch (Exception ignored) {}
                    }
                }
                if (tankId != null && canonical.getData().get("liters") != null) {
                    BigDecimal liters = new BigDecimal(canonical.getData().get("liters").toString());
                    tankExpectedStateService.applyDispense(canonical.getTenantId(), canonical.getStationId(), tankId, liters);
                }
                twinStateService.computeAndSave(canonical.getTenantId(), canonical.getStationId());
                sseEmitterRegistry.broadcast(canonical.getStationId(), twinStateService.buildSnapshotDto(canonical.getTenantId(), canonical.getStationId()));
            } else if ("TANK_READING".equals(canonical.getEventType())) {
                Object tIdObj = canonical.getData().get("tankId");
                Object repLitersObj = canonical.getData().get("reportedLiters");
                if (tIdObj != null && repLitersObj != null) {
                    try {
                        UUID tankId = UUID.fromString(tIdObj.toString());
                        BigDecimal repLiters = new BigDecimal(repLitersObj.toString());
                        tankExpectedStateService.anchorFromReading(canonical.getTenantId(), canonical.getStationId(), tankId, repLiters);
                    } catch (Exception ignored) {}
                }
                twinStateService.computeAndSave(canonical.getTenantId(), canonical.getStationId());
                sseEmitterRegistry.broadcast(canonical.getStationId(), twinStateService.buildSnapshotDto(canonical.getTenantId(), canonical.getStationId()));
            }

            log.debug("Normalized event: type={} station={}", canonical.getEventType(), canonical.getStationId());
        } catch (Exception e) {
            log.error("Normalization failed for raw event {}: {}", raw.getId(), e.getMessage(), e);
        }
    }

    private String mapEventType(String rawType) {
        return switch (rawType.toUpperCase()) {
            case "DISPENSE", "TRANSACTION", "FUEL_DISPENSE" -> "FUEL_DISPENSE";
            case "TANK_READING", "TANK_LEVEL", "DIP" -> "TANK_READING";
            case "PRICE_CHANGE", "PRICE" -> "PRICE_CHANGE";
            case "DELIVERY", "TANK_DELIVERY" -> "DELIVERY";
            case "PAYMENT" -> "PAYMENT";
            default -> rawType.toUpperCase();
        };
    }

    private Map<String, Object> normalizePayload(RawEvent raw) {
        Map<String, Object> payload = raw.getPayload();
        Map<String, Object> data = new HashMap<>();

        switch (raw.getEventType().toUpperCase()) {
            case "DISPENSE", "TRANSACTION", "FUEL_DISPENSE" -> {
                data.put("nozzleId", payload.getOrDefault("nozzleId", payload.get("nozzle_id")));
                if (payload.containsKey("tankId") || payload.containsKey("tank_id")) {
                    data.put("tankId", payload.getOrDefault("tankId", payload.get("tank_id")));
                }
                data.put("liters", toBigDecimal(payload.getOrDefault("liters", payload.get("volume"))));
                data.put("unitPrice", toBigDecimal(payload.getOrDefault("unitPrice", payload.get("unit_price"))));
                data.put("totalAmount", toBigDecimal(payload.getOrDefault("totalAmount", payload.get("total_amount"))));
                data.put("shiftId", payload.getOrDefault("shiftId", payload.get("shift_id")));
            }
            case "TANK_READING", "TANK_LEVEL", "DIP" -> {
                data.put("tankId", payload.getOrDefault("tankId", payload.get("tank_id")));
                data.put("reportedLiters", toBigDecimal(payload.getOrDefault("reportedLiters", payload.get("level"))));
                data.put("dipType", payload.getOrDefault("dipType", "VOLUME"));
            }
            case "PRICE_CHANGE", "PRICE" -> {
                data.put("productId", payload.getOrDefault("productId", payload.get("product_id")));
                data.put("oldPrice", toBigDecimal(payload.get("oldPrice")));
                data.put("newPrice", toBigDecimal(payload.getOrDefault("newPrice", payload.get("price"))));
            }
            case "DELIVERY", "TANK_DELIVERY" -> {
                data.put("tankId", payload.getOrDefault("tankId", payload.get("tank_id")));
                data.put("volumeAdded", toBigDecimal(payload.getOrDefault("volumeAdded", payload.get("volume"))));
                data.put("supplier", payload.getOrDefault("supplier", "Unknown"));
            }
            case "PAYMENT" -> {
                data.put("paymentType", payload.getOrDefault("paymentType", "CASH"));
                data.put("amount", toBigDecimal(payload.get("amount")));
                data.put("reference", payload.get("reference"));
                data.put("shiftId", payload.get("shiftId"));
            }
            default -> {
                data.putAll(payload);
            }
        }
        return data;
    }

    private BigDecimal toBigDecimal(Object value) {
        if (value == null)
            return BigDecimal.ZERO;
        if (value instanceof BigDecimal bd)
            return bd;
        if (value instanceof Number n)
            return BigDecimal.valueOf(n.doubleValue());
        try {
            return new BigDecimal(value.toString());
        } catch (Exception e) {
            return BigDecimal.ZERO;
        }
    }
}
