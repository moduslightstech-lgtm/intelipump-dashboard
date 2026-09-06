package com.fuelops.mqtt;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.eclipse.paho.client.mqttv3.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@RequiredArgsConstructor
@Slf4j
public class MqttSubscriberConfig {

    @Value("${mqtt.host:localhost}")
    private String mqttHost;

    @Value("${mqtt.port:1883}")
    private int mqttPort;

    @Value("${mqtt.username:}")
    private String mqttUsername;

    @Value("${mqtt.password:}")
    private String mqttPassword;

    @Value("${mqtt.topic:intelipump/#}")
    private String mqttTopic;

    @Value("${mqtt.client-id:fuelops-api-sub}")
    private String clientId;

    private final MqttMessageHandler messageHandler;

    @Bean
    public MqttClient mqttClient() throws MqttException {
        String brokerUrl = "tcp://" + mqttHost + ":" + mqttPort;
        MqttClient client = new MqttClient(brokerUrl, clientId, null);

        MqttConnectOptions options = new MqttConnectOptions();
        options.setAutomaticReconnect(true);
        options.setCleanSession(true);
        options.setConnectionTimeout(10);
        options.setKeepAliveInterval(30);

        if (mqttUsername != null && !mqttUsername.trim().isEmpty()) {
            options.setUserName(mqttUsername.trim());
            if (mqttPassword != null && !mqttPassword.isEmpty()) {
                options.setPassword(mqttPassword.toCharArray());
            }
        }

        client.setCallback(new MqttCallback() {
            @Override
            public void connectionLost(Throwable cause) {
                log.warn("MQTT connection lost: {}", cause != null ? cause.getMessage() : "unknown reason");
            }

            @Override
            public void messageArrived(String topic, MqttMessage message) {
                try {
                    messageHandler.handle(topic, new String(message.getPayload()));
                } catch (Exception e) {
                    log.error("Error handling MQTT message on {}: {}", topic, e.getMessage(), e);
                }
            }

            @Override
            public void deliveryComplete(IMqttDeliveryToken token) {
            }
        });

        try {
            client.connect(options);
            client.subscribe(mqttTopic, 1);
            log.info("MQTT subscriber connected to {} and subscribed to {}", brokerUrl, mqttTopic);
        } catch (MqttException e) {
            log.warn("MQTT broker not available at startup ({}). Will retry via auto-reconnect: {}", brokerUrl, e.getMessage());
        }

        return client;
    }
}
