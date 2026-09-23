# AlphaESS Hardware

The following hardware should work with Energy Manager. Please note that different models and firmware versions can behave differently so some small configuration changes may need to be made to make a specific model work correctly. Not all models have been tested.

⚠️Draft compatibility list

This is a draft compatibilty list. These models should work but are in no way guaranteed until they have been reported as working.

## Single-phase models

- SMILE-G3-S5 - 5kW Hybrid-coupled with 10.1kWh built-in battery
- SMILE-S5 - 5kW Hybrid-coupled with 5.04kWh built-in battery
- SMILE5 - 5kW with multiple battery options (2.9kWh, 5.7kWh, 10.1kWh, 13.3kWh)
- SMILE-Hi5 - 5kW (4.8-46.8kWh battery capacity range)a

## Three-phase models

- SMILE-G3-T4 - 4kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T6 - 6kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T8 - 8kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T10 - 10kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T12 - 12kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T15 - 15kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-G3-T20 - 20kW Three-phase (7.3-21.9kWh / 7.8-46.8kWh)
- SMILE-Hi10 - 10kW (7.8-46.8kWh battery capacity range)-
- SMILE-T10-HV - 10kW with 8.2kWh high voltage battery module

## AC-Coupled Models (Retrofit)

- SMILE-G3-B5 - 5kW AC-coupled with 10.1kWh battery
- SMILE-B5 - 5kW AC-coupled with 5.04kWh built-in battery
- SMILE-B3-PLUS - 3kW AC-coupled with 5.04kWh battery (single-phase only)

## Batteries

- SMILE-G3-BAT-10.1P (10.1kWh modules)
- SMILE-BAT-5P (5.04kWh modules)
- SMILE-Hi5-BAT-7.8 (7.8kWh modules)

## Other requirements

A wired ethernet connection is required.

## Notes

Even though the AlphaESS does support WiFi for cloud communications with the AlphaESS servers for app-based monitoring and control, remote support and diagnostics, it will not allow suitable Modbus access on your local network which is needed for Energy Manager. Therefore, you will need a wired ethernet connection from your inverter to your home network. If you use the ethernet connection for Modbus, you can still use the WiFi connection for app monitoring and cloud features.

ℹ️Important

Not all of these hardware models have been tested, but should work. Any that are found to NOT work will be removed the moment it is discovered.
