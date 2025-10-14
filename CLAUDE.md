# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a NetSapiens load generator tool designed to create realistic VoIP testing environments. It generates domains, users, devices, call queues, and agents via the NetSapiens API v2, then uses SIPp scripts to simulate real phone system load including registrations, subscriptions, and inbound calls.

## Core Architecture

### Main Entry Point
- `server.js` - Main application entry point that orchestrates domain, user, device, and queue creation

### Library Structure
- `lib/nsapi.js` - NetSapiens API v2 wrapper with create/update functions
- `lib/randomdata.js` - Provides arrays of realistic data (phone models, departments, timezones, queue names)
- `lib/utils.js` - Utility functions for CSV generation, domain sizing, and random number generation

### Data Generation Flow
1. **Domain Creation**: Creates random company domains with configurable size distributions (1% >1k users, 5% >100 users, rest 5-50 users)
2. **User Generation**: Creates users with random names, sites, departments, and scopes (Office Manager, Call Center Supervisor, Basic User)
3. **Device Provisioning**: Creates SIP devices with secure passwords and optional MAC addresses (50% of devices)
4. **Queue Setup**: Creates call queues (1 per 10 users) with random agent assignments (10% of domain users per queue)
5. **CSV Generation**: Outputs SIPp-compatible CSV files for registrations and inbound calling

### SIPp Integration
- `sipp/scripts/` - Contains SIPp XML scenarios and bash orchestration scripts
- `sipp/csv/` - Generated CSV files for devices and phone numbers organized by timezone
- `cron/start_sipp` - Cron configuration for automated load generation across US timezones

## Key Configuration

### Environment Variables (.env)
- `TARGET_SERVER` - Target NetSapiens server hostname
- `APIKEY` - NetSapiens API key with super user scope  
- `MAX_DOMAIN` - Number of domains to generate
- `PEAK_CPS` - Peak calls per second during testing
- `REGISTRATION_PCT` - Percentage of devices to register
- `SEED` - Random seed for reproducible data generation

## Common Commands

### Setup and Installation
```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your TARGET_SERVER and APIKEY
```

### Generate Load Test Data
```bash
# Generate domains, users, devices, queues and SIPp CSV files
node server.js
```

### SIPp Load Generation
```bash
# Run all registration scripts (typically via cron)
sipp/scripts/register_all.sh

# Run inbound calling for specific timezone
sipp/scripts/inbound.sh "US_Eastern"
```

## Testing Architecture

The system simulates realistic business environments:
- **Multi-tenant**: Random company domains with varied sizes
- **Geographic Distribution**: 7 US timezones with scheduled calling patterns
- **Realistic Calling**: 8-hour business day patterns per timezone
- **Device Diversity**: Multiple phone models and transport types (UDP/TCP/TLS)
- **Call Center Features**: Queues, agents, statistics tracking, and call recording

## File Organization

- **Generated Data**: All CSV files go in `sipp/csv/` organized by devices/ and phonenumbers/
- **Audio Files**: WAV and PCAP files for realistic call simulation in `sipp/scripts/`
- **Cron Jobs**: Automated scheduling in `cron/` directory
- **Auxiliary Tools**: Socket.io testing in `sockettester/`, PHP SIPp API in `sipp-api/`