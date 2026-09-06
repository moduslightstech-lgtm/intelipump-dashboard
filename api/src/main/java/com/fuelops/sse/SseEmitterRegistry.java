package com.fuelops.sse;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Thread-safe registry of SSE emitters keyed by stationId.
 * Broadcasts twin snapshots to all connected UI clients.
 */
@Component
@Slf4j
public class SseEmitterRegistry {

    private final Map<UUID, List<SseEmitter>> emitters = new ConcurrentHashMap<>();

    public SseEmitter addEmitter(UUID stationId) {
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);
        emitters.computeIfAbsent(stationId, k -> new CopyOnWriteArrayList<>()).add(emitter);

        emitter.onCompletion(() -> remove(stationId, emitter));
        emitter.onTimeout(() -> remove(stationId, emitter));
        emitter.onError(e -> remove(stationId, emitter));

        log.debug("SSE client connected for station {}", stationId);
        return emitter;
    }

    public void broadcast(UUID stationId, Object payload) {
        broadcast(stationId, "twin-update", payload);
    }

    public void broadcast(UUID stationId, String eventName, Object payload) {
        List<SseEmitter> list = emitters.getOrDefault(stationId, List.of());
        List<SseEmitter> dead = new ArrayList<>();

        for (SseEmitter emitter : list) {
            try {
                emitter.send(SseEmitter.event()
                        .name(eventName)
                        .data(payload));
            } catch (IOException e) {
                dead.add(emitter);
            }
        }
        dead.forEach(d -> remove(stationId, d));
    }

    private void remove(UUID stationId, SseEmitter emitter) {
        List<SseEmitter> list = emitters.get(stationId);
        if (list != null) {
            list.remove(emitter);
            log.debug("SSE client disconnected for station {}", stationId);
        }
    }

    public int connectedCount(UUID stationId) {
        return emitters.getOrDefault(stationId, List.of()).size();
    }
}
