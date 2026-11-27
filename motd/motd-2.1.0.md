# Energy Manager v2.1.0

Welcome to Energy Manager v2.1.0

**This version is not yet released. Use at your own risk.**

## Flexible Load Scheduler

Automatically schedule household appliances such as pool pumps, washing machines, dryers and dishwashers to make the best use of available solar energy, battery storage and cheaper electricity rates.

Set your preferred operating hours, energy source and scheduling flexibility, and Energy Manager will recommend the most suitable time to run. Create recurring schedules, save up to 20 favourite workloads for quick reuse, and automatically adjust scheduled loads as energy forecasts change.

All designed to maximise solar self-consumption, reduce electricity costs and provide greater control over when your appliances run.

## FoxESS Support

Energy Manager v2.1.0 introduces support for FoxESS inverters, allowing users to automatically manage battery charging, discharging and solar energy usage based on Energy Manager's intelligent decisions. FoxESS users can now take advantage of smarter energy management to maximise solar usage, reduce electricity costs and make the most of their battery storage.

## PV Dashboard framework update

The customisable PV Dashboard framework has been updated. Tabs now replace profiles (existing profiles will be converted to tabs), with up to eight being able to be created. Now individual logins to Home Assistant will get to create their very own set of dashboards. Each dashboard that you create can now support between 1 to 8 columns, definable by yourself.

Optimisations have also been made to reduce the resource requirements of the customisable dashboard.

## New PV Dashboard cards

The following new cards are available to be enabled on the PV Dashboard (hidden by default):
* Energy Consumption - this is a bar chart showing you where your energy consumption is coming from - solar, battery or grid, and at what time of the day
* Battery Level Bar - a horizontal battery level bar to allow a quick glance at the current battery level
* Battery Outlook - gives a quick summary of your battery charge, expected overnight low, and how energy you are expecting to import from the grid until solar generation can provide (if your battery is scheduled to meet the minimum SOC set)
* System Limits - shows if there are constraints on your system, for example, curtailment is active or your battery is full
* Solar Headroom - allows you to quickly add a load's details (kw, run time) and it will provide you with the suggested best time to run that load
* Daily Plan Recap - provides a summary of today's plan and how you're tracking
* Solar Performance - displays a history of your solcast forecast vs your actual generation, to help you confirm whether your Solcast estimates are accurate or not, allowing you to go and fine-tune your settings if required
* BOM Rain Radar - near live BOM weather radar

## Power Boost

A new button has been created which, when enabled, will increase your expected daily power usage by 20%. This means that if you anticipate increased power use for the day, which is not reflected in your power usage profile, that Energy Manager will take this into consideration when making decisions. For example, if your hourly usage is normally 5kWh, when enabled it will assume you will be using 6kWh, and will plan appropriately. This will usually mean that any charging from the grid will occur earlier. Note that the Power Boost button will turn itself off at midnight so that you don't forget to turn it off yourself. You can turn it off before midnight yourself, if the boost should only be very temporary. Note also that the button is disabled and hidden by default, but can be found when you customise your PV Dashboard.

## Support for two batteries (on separate inverters)

If you have two inverters each with their own batteries, Energy Manager v2.1.0 can now support both sets of battery levels by adding them together (this assumes an appropriate integration is installed to read the second battery stack). Note that this is not the same as two stacks of batteries on the same inverter.

## Buy and Sell Daily Totals 

Optimisations have been made to try and more accurately reflect buy and sell totals. Home Assistant only registers values when the state changes at the 5 min mark, so if two consecutive interval happens to have the same profit, for example, the second one is not recorded. The v2.1.0 update should work around the Home Assistant "limitation" and record all intervals.

## Goodwe Stability

Fixes have occurred with the Goodwe scripts to add some more stability to Energy Manager decisions and controls.

## Various other bug fixes

Refer to the Changelog, on the right, for other bug fixes/updates included in v2.1.0
