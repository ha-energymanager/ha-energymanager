# Basic Principles

This guide is specific to **Amber Electric** and **LocalVolts**. Please refere to the [Flow Power guide](basic_principles-fp.md) or the [Globird guide](basic_principles-gb.md) for principles specific to retail optimisation.

### Price fluctuations

When you're on the wholesale market (either through Amber Electric or LocalVolts), prices can change **every 5 minutes**. Electricity is the cheapest to buy during the day, increases a lot during the demand period (usually 4-9pm), then decreases during the night (but stays higher than during the day), and then sometimes there is a morning shoulder peak, then it drops down during the day again. Prices are cheapest during the day simply because of the large amount of renewables (solar and wind) being generated at the time. It is simply supply & demand that drives the pricing.

When these buy prices go up and down, so does the sell (or 'fit' (feed-in-tariff)) pricing. The sell pricing generally sits about 4-6c lower than the buy price. Note that Amber Electric's pricing is usually 2-3c more expensive than LocalVolts pricing due to a buy-price guarantee hedging fund that puts a bit extra on the per kWh price.

Sometimes prices are negative, especially exports. If this is the case, then Energy Manager will curtail, or stop, exports so that you don't have to pay the negative sell price. If the buy price is negative (on rare occasions), then Energy Manager will aim to turn off your inverter and force the power to be drawn from the grid, since you would be paid to use power. Note, Energy Manager is designed to stop drawing from the grid for **any** price if it is during a demand period.

### Battery Capacity

**Energy Manager will always aim to have your battery fully charged by 4pm**, which is usually when the **demand period** starts.

If you're on a demand tariff, then you don't want to ever pull electricity from the grid during this time (this varies, but generally 4-9pm daily).

If your solar array has the capacity, it should be possible to fully charge your battery from the sun during the summer, and mostly charge it during the other seasons. However, if you aren't going to be able to obtain a full battery by 4pm, it is generally more economical to automatically charge your battery to 100% so that you use the cheaper day-time pricing to store electricity in your battery to use when the buy pricing is higher later on.

If your solar array size and battery capacity is such that you can't normally fully charge your battery, then Energy Manager will charge it up for you automatically. If your solar array size and battery are sized so that they can easily be charged purely by the sun, then Energy Manager won't charge your battery for you - unless the solar forecast predicts that there is not enough solar generation remaining to do it yourself (e.g., bad weather), then it will charge it up ready for later use.

### Charging your battery

There are two methods to charge your battery:

a\. From the electricity generated from your solar array

b\. From importing from the grid

Energy Manager aims to work out what the best method is for you. If your system is capable of generating and storing enough electricity to charge your battery without help, it will not take from the grid - unless the buy price is negative, then it is better to charge from the grid as this would result in you being paid to charge your battery.

### Discharging your battery

Ideally you should only discharge your battery under two circumstances:

a\. During high price spikes - it is better to get paid up to \$17/kWh for export than use yourself. If you need to buy it again (because you ran out during the night) at 20c/kWh, you still gain overall.

b\. After the sun has gone down (or you're generating less than you are using, and it is cheaper to use your stored power than take from the grid).

Note that sometimes it is better to take from the grid than from your battery, as in reality your battery only has a limited number of charge cycles, so you are wearing out the battery - if it costs 3c/kWh to take from the grid, that is actually cheaper than taking from your battery!

### Curtailing Exports

If the sell/export/fit price is negative, then you will be **charged** to export excess solar energy. Energy Manager monitors the sell price and will send a configuration command to your inverter to stop your exports (in reality, it sets it to 100W as a 0W setting is seen as 'unlimited').

### Importing from the grid

Energy Manager will import power from the grid under the following circumstances:

a\. You have no power left in your battery (or the reserve has been met)

b\. It is cheaper to purchase from the grid than use the power stored in your battery

c\. The grid buy price is negative (yes, it does happen)

### Exporting to the grid

The traditional, or default, battery management system is to charge your battery while the sun is out, and use the stored power from your battery when the sun goes down. Then charge up the next day again. It won't export your power unless you manually instruct it to do so. Energy Manager doesn't follow this traditional, or default, energy management - it uses some smarts and logic to work out what is best for your situation and exports automatically when it can detect it is best for you to do so.

**It will export your power during price spikes.** These spikes can be as high as \$17/kWh, but they can come and go quickly, so it can be near impossible to manually perform an export task on your inverter as each 5-minute interval may be a different price, and come and go quickly. You also don't want to be monitoring the prices like an eagle, as no-one really has the time to do that. Some spikes only last a single 5-minute interval - while others may last an hour or two. Large price spikes (over \$10/kWh) don't occur that often so you want to have an automated system do the export for you, then stop exporting as soon as the spike ends. This is where Energy Manager will do the automation for you.

ℹ️Navigation

[↩ Back to Operational Instructions](operational.md)

[↩ Back to Documents](index.md)
