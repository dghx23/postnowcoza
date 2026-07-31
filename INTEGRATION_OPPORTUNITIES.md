# Integration Opportunities

## Mapbox Location Agent (Conversational Maps)

**Source**: https://www.mapbox.com/blog/maps-turn-conversational  
**Date**: Nov 20, 2025

### What It Is
Mapbox Location Agent: location-aware conversational AI built on LLM + Mapbox MCP Server. Enables **conversational maps** where users ask natural-language questions about locations/routes and get visual, actionable answers on an interactive map.

### How It Works
1. LLM interprets user's query + geographic context
2. Mapbox MCP Server retrieves geocodes, geometries, directions via Mapbox APIs
3. Agent invokes map rendering/interaction to layer responses on map
4. Supports free-flowing, multi-turn conversations

### Real-World Example
**Prompt**: "What museums have special exhibits open during my trip that I could walk to in about 10 minutes from the main hotels close to Times Square?"

**Response**: 
- Geocodes Times Square
- Identifies hotels in that area
- Builds 10-minute walk isochrones from each hotel
- Queries museums within those zones
- Researches current exhibits
- Returns all results plotted on visual map (seconds)

### Applicable Use Cases

#### PostNow Express (Courier Booking)
- **Pick-up location selection**: "Find a locker drop-off near the Gauteng highways" → visualize Pudo lockers on map with isochrones
- **Delivery visualization**: Show sender + recipient on map with route & ETA
- **Zone-aware rate lookup**: "What's the fastest courier pickup from [address]?" → map highlights service areas

#### GlobeMe (US→SA Shopping)
- **Delivery ETA**: "When will my order arrive at my address?" → show estimated delivery zone on map
- **Route visualization**: US warehouse → shipping port → SA customs → delivery address
- **Neighborhood lookup**: "Which neighborhoods near my delivery address have good logistics access?" → map analysis

#### E2 (Document Dispatch)
- **Facility optimization**: "Where should we place print facilities to minimize delivery times to [region]?" → geospatial analysis
- **Route planning**: Staff can ask "Best courier for this delivery?" → visual route comparison on map
- **Return pathway**: "Show me the fastest return route from recipient to facility" → mapped route


### Implementation Path

**Resources**:
- GitHub: https://github.com/mapbox/mcp-server
- Docs: https://docs.mapbox.com/api/guides/mcp-server/
- Request access: https://www.mapbox.com/forms/location-agent

**Integration Steps**:
1. Set up Mapbox account & API tokens
2. Implement Mapbox MCP Server in Claude context
3. Wire Mapbox APIs (Geocoding, Directions, Matrix API for isochrones)
4. Connect LLM reasoning to map rendering
5. Layer project-specific data (couriers, rate cards, risk zones) on map

**Current Mapbox Products Relevant**:
- Search Box (address input)
- Geocoding API (location lookup)
- Directions API (routing)
- Matrix API (isochrone generation for delivery zones)
- Static/Interactive Maps (visualization)

### Next Steps
- Schedule proof-of-concept for PostNow Express (zone-aware rate lookup + visual pickup selection)
- Evaluate GlobeMe route visualization (US→SA shipping transparency)
- Consider RiskAtlas as primary candidate (geospatial analysis is core value prop)
