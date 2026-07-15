// Stub for react-native-maps on web
// react-native-maps is native-only and crashes Metro when bundling for web.
// This stub provides a fully-functional Leaflet OpenStreetMap implementation.

const React = require('react');
const { View } = require('react-native');

// Mock components that just return null so React does not render them to the DOM,
// but the parent MapView can read their props.
const Marker = (props) => null;
Marker.displayName = 'Marker';

const Polygon = (props) => null;
Polygon.displayName = 'Polygon';

const Polyline = (props) => null;
Polyline.displayName = 'Polyline';

const Circle = (props) => null;
Circle.displayName = 'Circle';

const Callout = (props) => null;
Callout.displayName = 'Callout';

// MapView component
function MapView(props) {
  const containerRef = React.useRef(null);
  const mapInstanceRef = React.useRef(null);
  const layersRef = React.useRef([]);
  const [leafletLoaded, setLeafletLoaded] = React.useState(false);

  // Load Leaflet dynamically
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.L) {
      setLeafletLoaded(true);
      return;
    }

    // Check if script is already injected
    let script = document.getElementById('leaflet-js');
    if (!script) {
      // Inject CSS
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.id = 'leaflet-css';
      document.head.appendChild(link);

      // Inject JS
      script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.id = 'leaflet-js';
      script.async = true;
      document.head.appendChild(script);
    }

    const interval = setInterval(() => {
      if (window.L) {
        clearInterval(interval);
        setLeafletLoaded(true);
      }
    }, 100);

    return () => clearInterval(interval);
  }, []);

  // Compute zoom from latitudeDelta
  const getZoomFromDelta = (latDelta) => {
    if (!latDelta) return 13;
    return Math.round(Math.log2(360 / latDelta));
  };

  // Initialize Map
  React.useEffect(() => {
    if (!leafletLoaded || !containerRef.current || mapInstanceRef.current) return;

    const L = window.L;
    const initialRegion = props.initialRegion || props.region || { latitude: 13.0827, longitude: 80.2707, latitudeDelta: 0.0922, longitudeDelta: 0.0421 };
    const zoom = getZoomFromDelta(initialRegion.latitudeDelta);

    // Leaflet needs the actual DOM element
    // In react-native-web, containerRef.current is the DOM element (div)
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false
    }).setView([initialRegion.latitude, initialRegion.longitude], zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map);

    mapInstanceRef.current = map;

    // Listen to map moves/zooms
    if (props.onRegionChangeComplete) {
      map.on('moveend', () => {
        const center = map.getCenter();
        const bounds = map.getBounds();
        const southWest = bounds.getSouthWest();
        const northEast = bounds.getNorthEast();
        props.onRegionChangeComplete({
          latitude: center.lat,
          longitude: center.lng,
          latitudeDelta: Math.abs(northEast.lat - southWest.lat),
          longitudeDelta: Math.abs(northEast.lng - southWest.lng)
        });
      });
    }

    // Force map size update (Leaflet container sizing fix)
    setTimeout(() => {
      map.invalidateSize();
    }, 100);

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [leafletLoaded]);

  // Update map center/zoom when region changes
  React.useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const region = props.region;
    if (region) {
      const zoom = getZoomFromDelta(region.latitudeDelta);
      map.setView([region.latitude, region.longitude], zoom);
    }
  }, [props.region]);

  // Draw children overlays (Markers, Polygons, etc.)
  React.useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !leafletLoaded) return;

    const L = window.L;

    // Clear old overlays
    layersRef.current.forEach(layer => map.removeLayer(layer));
    layersRef.current = [];

    // Parse children
    const childrenArray = React.Children.toArray(props.children);
    childrenArray.forEach(child => {
      if (!child) return;

      const type = child.type && (child.type.displayName || child.type.name);

      if (type === 'Marker') {
        const { coordinate, title, description, pinColor } = child.props;
        if (coordinate && coordinate.latitude && coordinate.longitude) {
          const color = pinColor || '#FF3B30';
          const icon = L.divIcon({
            className: 'rnm-pin',
            html: `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
                     <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
                     <circle cx="12" cy="12" r="5" fill="#fff"/>
                   </svg>`,
            iconSize: [24, 32],
            iconAnchor: [12, 32],
            popupAnchor: [0, -28],
          });
          const marker = L.marker([coordinate.latitude, coordinate.longitude], { icon }).addTo(map);
          if (title || description) {
            marker.bindPopup(`<b>${title || ''}</b>${description ? `<br/>${description}` : ''}`);
          }
          layersRef.current.push(marker);
        }
      } else if (type === 'Polygon') {
        const { coordinates, fillColor, strokeColor, strokeWidth } = child.props;
        if (coordinates && coordinates.length > 0) {
          const latlngs = coordinates.map(c => [c.latitude, c.longitude]);
          const polygon = L.polygon(latlngs, {
            fillColor: fillColor || '#3388ff',
            color: strokeColor || '#3388ff',
            weight: strokeWidth || 3,
            fillOpacity: 0.4
          }).addTo(map);
          layersRef.current.push(polygon);
        }
      } else if (type === 'Polyline') {
        const { coordinates, strokeColor, strokeWidth } = child.props;
        if (coordinates && coordinates.length > 0) {
          const latlngs = coordinates.map(c => [c.latitude, c.longitude]);
          const polyline = L.polyline(latlngs, {
            color: strokeColor || '#3388ff',
            weight: strokeWidth || 3
          }).addTo(map);
          layersRef.current.push(polyline);
        }
      } else if (type === 'Circle') {
        const { coordinate, radius, fillColor, strokeColor, strokeWidth } = child.props;
        if (coordinate && coordinate.latitude && coordinate.longitude) {
          const circle = L.circle([coordinate.latitude, coordinate.longitude], {
            radius: radius || 100,
            fillColor: fillColor || '#3388ff',
            color: strokeColor || '#3388ff',
            weight: strokeWidth || 3,
            fillOpacity: 0.4
          }).addTo(map);
          layersRef.current.push(circle);
        }
      }
    });

  }, [leafletLoaded, props.children]);

  // Adjust Leaflet map when size changes
  React.useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      const resizeObserver = new ResizeObserver(() => {
        map.invalidateSize();
      });
      resizeObserver.observe(containerRef.current);
      return () => resizeObserver.disconnect();
    }
  }, [leafletLoaded]);

  return React.createElement(View, {
    ref: containerRef,
    style: [
      { flex: 1, minHeight: 300, minWidth: 300, backgroundColor: '#f3f4f6' },
      props.style
    ]
  });
}

MapView.Marker = Marker;
MapView.Callout = Callout;
MapView.Polygon = Polygon;
MapView.Polyline = Polyline;
MapView.Circle = Circle;

module.exports = MapView;
module.exports.default = MapView;
module.exports.Marker = Marker;
module.exports.Callout = Callout;
module.exports.Polygon = Polygon;
module.exports.Polyline = Polyline;
module.exports.Circle = Circle;
module.exports.PROVIDER_GOOGLE = 'google';
module.exports.PROVIDER_DEFAULT = 'default';
