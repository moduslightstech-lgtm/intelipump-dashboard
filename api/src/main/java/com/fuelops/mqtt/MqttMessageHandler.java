package com.fuelops.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fuelops.ingestion.IngestionService;
import com.fuelops.ingestion.RawEvent;
import com.fuelops.normalization.CanonicalEvent;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.normalization.PaymentEvent;
import com.fuelops.normalization.PaymentEventRepository;
import com.fuelops.sse.SseEmitterRegistry;
import com.fuelops.statemachine.StationStateMachineService;
import com.fuelops.statemachine.StationStateMachineService.EventKind;
import com.fuelops.statemachine.StationStateMachineService.MachineEvent;
import com.fuelops.twin.TankExpectedStateService;
import com.fuelops.twin.TwinStateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Handles incoming MQTT messages.
 * Topic pattern: fuelops/{tenantId}/{stationId}/{eventType}
 *
 * Pipeline:
 * 1. Parse topic → tenantId, stationId, eventType
 * 2. Store as RawEvent (idempotent via source="MQTT_SIM")
 * 3. Update TankExpectedState (DISPENSE → subtract, TANK_READING → anchor)
 * 4. Transition station state machine
 * 5. Recompute twin snapshot
 * 6. Broadcast to SSE clients
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class MqttMessageHandler {

    private final IngestionService ingestionService;
    private final TankExpectedStateService tankExpectedStateService;
    private final StationStateMachineService stateMachineService;
    private final TwinStateService twinStateService;
    private final SseEmitterRegistry sseEmitterRegistry;
    private final CanonicalEventRepository canonicalEventRepository;
    private final PaymentEventRepository paymentEventRepository;
    private final ObjectMapper objectMapper;

    public void handle(String topic, String rawPayload) {
        try {
            // Parse topic: fuelops/{tenantId}/{stationId}/{eventType}
            String[] parts = topic.split("/");
            if (parts.length < 4) {
                log.warn("Unexpected MQTT topic format: {}", topic);
                return;
            }
            UUID tenantId = UUID.fromString(parts[1]);
            UUID stationId = UUID.fromString(parts[2]);
            String eventType = parts[3].toUpperCase();

            @SuppressWarnings("unchecked")
            Map<String, Object> payload = objectMapper.readValue(rawPayload, Map.class);
            String eventId = payload.getOrDefault("eventId", UUID.randomUUID().toString()).toString();
            Instant deviceTime = payload.containsKey("deviceTime")
                    ? Instant.parse(payload.get("deviceTime").toString())
                    : Instant.now();

            // 1. Store as RawEvent (idempotent)
            RawEvent rawEvent = new RawEvent();
            rawEvent.setTenantId(tenantId);
            rawEvent.setStationId(stationId);
            rawEvent.setSource("MQTT_SIM");
            rawEvent.setEventId(eventId);
            rawEvent.setEventType(eventType);
            rawEvent.setPayload(new HashMap<>(payload));
            rawEvent.setDeviceTime(deviceTime);
            rawEvent.setReceivedTime(Instant.now());

            IngestionService.IngestResult result = ingestionService.ingest(rawEvent);
            if (result == IngestionService.IngestResult.DUPLICATE) {
                log.debug("Duplicate MQTT event {} ignored", eventId);
                return;
            }

            // 2. Apply domain effects based on event type
            EventKind kind = EventKind.RAW;
            switch (eventType) {
                case "DISPENSE" -> {
                    kind = EventKind.DISPENSE;
                    applyDispense(tenantId, stationId, payload);
                }
                case "TANK_READING" -> {
                    kind = EventKind.TANK_READING;
                    applyTankReading(tenantId, stationId, payload);
                }
                case "PAYMENT" -> {
                    kind = EventKind.PAYMENT;
                    applyPayment(tenantId, stationId, payload, deviceTime);
                }
            }

            // 3. Transition state machine
            stateMachineService.transition(tenantId, stationId, MachineEvent.EVENT_RECEIVED, kind);

            // 4. Recompute twin + broadcast SSE
            var snapshot = twinStateService.buildSnapshotDto(tenantId, stationId);
            sseEmitterRegistry.broadcast(stationId, snapshot);

            log.debug("Processed MQTT {} event for station {}", eventType, stationId);

        } catch (Exception e) {
            log.error("Failed to handle MQTT message on topic {}: {}", topic, e.getMessage(), e);
        }
    }

    private void applyDispense(UUID tenantId, UUID stationId, Map<String, Object> payload) {
        Object tankIdRaw = payload.get("tankId");
        Object litersRaw = payload.get("liters");
        if (tankIdRaw == null || litersRaw == null)
            return;
        try {
            UUID tankId = UUID.fromString(tankIdRaw.toString());
            BigDecimal liters = new BigDecimal(litersRaw.toString());
            tankExpectedStateService.applyDispense(tenantId, stationId, tankId, liters);
        } catch (Exception e) {
            log.warn("Could not apply dispense to tank state: {}", e.getMessage());
        }
    }

    private void applyTankReading(UUID tenantId, UUID stationId, Map<String, Object> payload) {
        Object tankIdRaw = payload.get("tankId");
        Object reportedRaw = payload.get("reportedLiters");
        if (tankIdRaw == null || reportedRaw == null)
            return;
        try {
            UUID tankId = UUID.fromString(tankIdRaw.toString());
            BigDecimal reported = new BigDecimal(reportedRaw.toString());
            tankExpectedStateService.anchorFromReading(tenantId, stationId, tankId, reported);
        } catch (Exception e) {
            log.warn("Could not anchor tank reading state: {}", e.getMessage());
        }
    }

    private void applyPayment(UUID tenantId, UUID stationId, Map<String, Object> payload, Instant eventTime) {
        try {
            PaymentEvent payment = new PaymentEvent();
            payment.setTenantId(tenantId);
            payment.setStationId(stationId);
            payment.setPaymentType(payload.getOrDefault("method", "CASH").toString());
            payment.setAmount(new BigDecimal(payload.getOrDefault("amount", "0").toString()));
            payment.setCurrency("NGN");
            payment.setShiftId("LIVE");
            payment.setReference(payload
                    .getOrDefault("reference", "MQTT-" + UUID.randomUUID().toString().substring(0, 8)).toString());
            payment.setEventTime(eventTime);
            paymentEventRepository.save(payment);
        } catch (Exception e) {
            log.warn("Could not save payment event: {}", e.getMessage());
        }
    }
}
