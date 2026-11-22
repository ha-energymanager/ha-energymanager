"""Exclude Energy Manager operations from load automation selection."""

import re

def automation_key(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")

AUTOMATION_EXCLUSIONS = sorted(map(automation_key, (
    "Check Inverter Connection",
    "Check SSH Key Periodically",
    "Clear Inverter Connection Notification",
    "Create Inverter MQTT Sensors",
    "Electricity: 5 Minute Import Cost & Export Price",
    "Electricity: Reset Export Profit Monthly",
    "Electricity: Reset Import and Export Energy Monthly",
    "Electricity: Reset import Cost Monthly",
    "EM: VictoriaMetrics first-boot setup",
    "Energy Manager - Manual Update Check",
    "Energy Manager - Perform Update",
    "Energy Manager - Scheduled Update Check",
    "Energy Manager - Update Failed Notification",
    "EV Readyby Mode Enabled",
    "EV Schedule Mode Enabled",
    "Flow Power in Offpeak Period",
    "Flow Power in Peak Period",
    "Force Charge Limit to Max Safety",
    "Force discharge hard limit to inverter rating",
    "Force Discharge Limit to Max Safety",
    "FoxESS - Dismiss Successful Scheduler Notifications",
    "FoxESS: Connection Lost",
    "FoxESS: Connection Restored",
    "Generate SSH Key (Shell)",
    "GoodWe EH: Reset all slots when slot selection changes",
    "GoodWe ET/ESA: Reset all slots when 4-slot selection changes",
    "High-Sell Mode Enabled",
    "Inverter Brand Changed",
    "Inverter Charge/Discharge Mode Changed",
    "Inverter Charge/Discharge Power Changed",
    "Inverter EMS Mode Changed",
    "Inverter Export Power Limit - Follow House Load",
    "Inverter Export Power Limit Changed",
    "Inverter Export Power Limit Enabled Changed",
    "Inverter Max Charge Power Changed",
    "Inverter Max Discharge Power Changed",
    "Inverter Max Power Limit Changed",
    "Inverter Max SOC Changed",
    "Inverter Min SOC Changed",
    "Inverter PV Power Limit Changed",
    "Inverter Reserved SOC Backup Changed",
    "Inverter Run Mode Changed",
    "Inverter: Battery Cutoff Protection",
    "Publish Inverter Data to MQTT",
    "Restart Reminder",
    "Restore Inverter Brand on Startup",
    "Save Inverter Brand Selection",
    "Sell-Buy Mode Enabled",
    "Solcast update",
    "Start Energy Control Timer When Switch Turns Off",
    "Sync Inverter Controls on Startup",
    "Turn Energy Control Switch On When Timer Finishes",
    "Update Energy Manager Decision Sensor",
)))

def excluded(entity_id, friendly_name):
    entity_key = re.sub(r"_\d+$", "", entity_id.removeprefix("automation."))
    return entity_key in AUTOMATION_EXCLUSIONS or automation_key(friendly_name) in AUTOMATION_EXCLUSIONS
