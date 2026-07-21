import './style.css'
import L from 'leaflet'
import { collection, onSnapshot, writeBatch, doc, deleteDoc } from 'firebase/firestore';
import { db } from './firebase.js';

// State
let properties = JSON.parse(localStorage.getItem('renty_properties')) || [];
let activePropertyId = null;
let syncTimeout = null;
let isSyncing = false;

// User Initials Setup
if (userNameInput) {
  userNameInput.value = localStorage.getItem('renty_user') || '';
  userNameInput.addEventListener('input', (e) => {
    localStorage.setItem('renty_user', e.target.value.trim());
  });
}

// Map Setup
// Initialize Map centered on London, bounded strictly to London Zones 1-3
const map = L.map('map', {
    maxBounds: [
        [51.40, -0.17], // South West (approx Tooting / Streatham edge)
        [51.55, 0.05]   // North East (approx Holloway / Stratford edge)
    ],
    maxBoundsViscosity: 1.0,
    minZoom: 11,
    fadeAnimation: false // Remove 250ms tile fade-in delay for snappier zooming
}).setView([51.505, -0.09], 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20,
    keepBuffer: 12,
    updateWhenIdle: false,
    updateWhenZooming: true, // Fetch intermediate tiles immediately during zoom
    updateInterval: 50
}).addTo(map);

// DOM Elements
const ingestForm = document.getElementById('ingest-form');
const htmlInput = document.getElementById('html-input');
const addressInput = document.getElementById('address-input');
const fileInput = document.getElementById('file-input');
const fileUploadBtn = document.querySelector('.file-upload-btn');
const forcePriceFreq = document.getElementById('force-price-freq');
const lockPinsToggle = document.getElementById('lock-pins-toggle');
const mobileTabList = document.getElementById('mobile-tab-list');
const mobileTabMap = document.getElementById('mobile-tab-map');
const sidebar = document.querySelector('.sidebar');
const mapContainer = document.querySelector('.map-container');
const priceToggle = document.getElementById('price-toggle');
const labelPcm = document.getElementById('label-pcm');
const labelPw = document.getElementById('label-pw');
const exportBtn = document.getElementById('export-btn');
const userNameInput = document.getElementById('user-name-input');
const errorMessage = document.getElementById('error-message');
const propertyList = document.getElementById('property-list');
const propertyCount = document.getElementById('property-count');
const displayModeSelect = document.getElementById('display-mode');
const uploadProgress = document.getElementById('upload-progress');

let pendingFiles = [];

// Tabs & Manual Form
const tabAuto = document.getElementById('tab-auto');
const tabManual = document.getElementById('tab-manual');
const manualForm = document.getElementById('manual-form');
const noteModal = document.getElementById('note-modal');
const closeModalBtn = document.querySelector('.close-btn');
const modalTitle = document.getElementById('modal-title');
const modalPrice = document.getElementById('modal-price');
const modalLink = document.getElementById('modal-link');
const modalNotes = document.getElementById('modal-notes');
const modalAddress = document.getElementById('modal-address');
const updateLocationBtn = document.getElementById('update-location-btn');
const saveNotesBtn = document.getElementById('save-notes-btn');
const deletePropertyBtn = document.getElementById('delete-property-btn');

const markers = {}; // Store marker instances by id
let displayMode = 'pcm';

priceToggle.addEventListener('change', (e) => {
    displayMode = e.target.checked ? 'pw' : 'pcm';
    if (displayMode === 'pw') {
        labelPw.style.color = 'var(--primary)';
        labelPw.style.fontWeight = 'bold';
        labelPcm.style.color = 'var(--text-secondary)';
        labelPcm.style.fontWeight = 'normal';
    } else {
        labelPcm.style.color = 'var(--primary)';
        labelPcm.style.fontWeight = 'bold';
        labelPw.style.color = 'var(--text-secondary)';
        labelPw.style.fontWeight = 'normal';
    }
    renderProperties();
    if (activePropertyId) openModal(activePropertyId);
});

function formatPrice(prop) {
    if (!prop.priceNum) {
        if (prop.price && prop.price !== 'Price TBA') {
            const numMatch = prop.price.match(/([0-9,]+)/);
            if (numMatch) prop.priceNum = parseInt(numMatch[1].replace(/,/g, ''), 10);
            prop.priceFreq = prop.price.toLowerCase().includes('pw') || prop.price.toLowerCase().includes('week') ? 'pw' : 'pcm';
        } else {
            return prop.price || 'Price TBA';
        }
    }
    if (!prop.priceNum) return prop.price || 'Price TBA';
    
    let num = prop.priceNum;
    if (prop.priceFreq === 'pcm' && displayMode === 'pw') {
        num = (num * 12) / 52;
    } else if (prop.priceFreq === 'pw' && displayMode === 'pcm') {
        num = (num * 52) / 12;
    }
    return '£' + Math.round(num).toLocaleString() + ' ' + displayMode;
}

// Render properties
function renderProperties() {
  propertyList.innerHTML = '';
  propertyCount.textContent = properties.length;
  
  properties.forEach(prop => {
    const li = document.createElement('li');
    li.className = 'property-card';
    li.innerHTML = `
      <h3>${prop.title || 'Unknown Property'}</h3>
      <div class="price">${formatPrice(prop)}</div>
      <span class="source">${prop.source || 'Unknown Source'}</span>
    `;
    li.addEventListener('click', () => {
      openModal(prop.id);
      map.setView([prop.lat, prop.lng], 15, { animate: true, duration: 0.5 });
    });
    propertyList.appendChild(li);
    
    // Add marker if not exists
    if (!markers[prop.id] && prop.lat && prop.lng) {
      const isLocked = lockPinsToggle.checked;
      const marker = L.marker([prop.lat, prop.lng], { 
          draggable: !isLocked,
          icon: L.divIcon({
              className: 'custom-div-icon',
              html: `<div style="background-color: ${prop.source === 'Rightmove' ? '#2563eb' : prop.source === 'Zoopla' ? '#7c3aed' : prop.source === 'SpareRoom' ? '#ea580c' : '#059669'}; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.5);"></div>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12]
          })
      }).addTo(map);
      marker.bindPopup(`<b>${prop.title}</b><br>${prop.price}`);
      marker.on('click', () => openModal(prop.id));
      
      marker.on('dragend', function() {
          const position = marker.getLatLng();
          prop.lat = position.lat;
          prop.lng = position.lng;
          saveData();
      });
      
      markers[prop.id] = marker;
    }
  });
  
  // Adjust map bounds to show all markers
  if (properties.length === 1) {
    map.setView([properties[0].lat, properties[0].lng], 14, { animate: true });
  } else if (properties.length > 1) {
    const group = new L.featureGroup(Object.values(markers));
    map.fitBounds(group.getBounds().pad(0.1), { animate: true });
  }
}

// Geocoding Fallback
async function geocodeAddress(address) {
  try {
    // Restrict search to UK (countrycodes=gb) and strongly bias to London (viewbox)
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&countrycodes=gb&viewbox=-0.510,51.691,0.334,51.286`);
    const data = await response.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.error("Geocoding failed:", err);
  }
  return null;
}

// Ingestion Logic
function extractCoordinatesFromScript(htmlString) {
  const latMatch = htmlString.match(/latitude["']?\s*[:=]\s*(-?\d+\.\d+)/i) || htmlString.match(/lat["']?\s*[:=]\s*(-?\d+\.\d+)/i);
  const lngMatch = htmlString.match(/longitude["']?\s*[:=]\s*(-?\d+\.\d+)/i) || htmlString.match(/lng["']?\s*[:=]\s*(-?\d+\.\d+)/i) || htmlString.match(/lon["']?\s*[:=]\s*(-?\d+\.\d+)/i);
  
  if (latMatch && lngMatch) {
    return { lat: parseFloat(latMatch[1]), lng: parseFloat(lngMatch[1]) };
  }
  return null;
}

function parseHTML(htmlString, forceFormat = 'auto') {
  // Decode MHTML Quoted-Printable encoding if present to prevent '=' in titles/text
  if (htmlString.includes('quoted-printable')) {
      htmlString = htmlString.replace(/=\r?\n/g, ''); // soft line breaks
      htmlString = htmlString.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
          try { return decodeURIComponent('%' + hex); } catch(e) { return match; }
      });
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  
  let extractedLink = '';
  // 1. Check for MHTML Snapshot-Content-Location
  const mhtmlLinkMatch = htmlString.match(/Snapshot-Content-Location:\s*(https?:\/\/[^\s]+)/i);
  if (mhtmlLinkMatch) {
      extractedLink = mhtmlLinkMatch[1];
  } else {
      // 2. Check for canonical link or og:url in HTML
      const canonical = doc.querySelector('link[rel="canonical"]');
      const ogUrl = doc.querySelector('meta[property="og:url"]');
      if (canonical && canonical.getAttribute('href')) {
          extractedLink = canonical.getAttribute('href');
      } else if (ogUrl && ogUrl.getAttribute('content')) {
          extractedLink = ogUrl.getAttribute('content');
      }
  }
  
  let result = {
    id: 'prop_' + Date.now(),
    link: extractedLink,
    notes: {},
    lat: 51.505 + (Math.random() - 0.5) * 0.1, // Randomize slightly if fallback
    lng: -0.09 + (Math.random() - 0.5) * 0.1,
    title: 'Unknown Property',
    price: 'Price TBA',
    source: 'Other',
    hasRealCoords: false
  };

  // Try extracting coordinates
  const coords = extractCoordinatesFromScript(htmlString);
  if (coords) {
    result.lat = coords.lat;
    result.lng = coords.lng;
    result.hasRealCoords = true;
  }

  // Price Extraction
  // 1. Try common DOM selectors for specific sites (including SpareRoom)
  const priceSelectors = [
    '#listing_price strong',
    '.listingPrice', 
    '.price strong', 
    '[data-testid="price"]', 
    '[data-bind="html: price"]',
    'h1 .price'
  ];
  
  for (let selector of priceSelectors) {
    const el = doc.querySelector(selector);
    if (el && el.textContent.match(/£|[0-9]/)) {
       result.price = el.textContent.trim().replace(/\s+/g, ' ');
       const numMatch = result.price.match(/([0-9,]+)/);
       if (numMatch) result.priceNum = parseInt(numMatch[1].replace(/,/g, ''), 10);
       result.priceFreq = result.price.toLowerCase().includes('pw') || result.price.toLowerCase().includes('week') ? 'pw' : 'pcm';
       if (forceFormat !== 'auto') result.priceFreq = forceFormat;
       break;
    }
  }

  // 2. Fallback broad search for Price if DOM selectors failed
  if (result.price === 'Price TBA') {
      // Check decoded body text first (handles &pound;)
      const bodyText = doc.body ? doc.body.textContent : '';
      let priceMatch = bodyText.match(/(?:£|=C2=A3)\s*([0-9,]+)/i);
      
      if (!priceMatch) {
          // Check raw HTML for HTML entities and Quoted-Printable
          priceMatch = htmlString.match(/(?:£|&pound;|&#163;|=C2=A3)\s*([0-9,]+)/i);
      }
      
      if (!priceMatch) {
          // Check for number followed by pcm/pw without pound sign (avoid grabbing part of =C2=A3 by using \b or lookbehind, but JS regex doesn't always support lookbehind well, so we rely on the above catching =C2=A3 first)
          priceMatch = htmlString.match(/(?<![A-Z])([0-9,]{3,})\s*(?:pcm|pw\b)/i);
      }
      
      if (!priceMatch) {
          // Check for "price": 850 in JSON/JS objects
          priceMatch = htmlString.match(/["']?price["']?\s*[:=]\s*["']?(£|&pound;|&#163;|=C2=A3)?\s*([0-9,]+)/i);
          if (priceMatch && priceMatch[2]) {
              priceMatch = [priceMatch[0], priceMatch[2]]; // normalize to match group 1
          }
      }
      
      if (priceMatch) {
          result.price = '£' + priceMatch[1];
          result.priceNum = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          result.priceFreq = htmlString.substring(priceMatch.index || 0, (priceMatch.index || 0) + 30).toLowerCase().includes('pw') || htmlString.substring(priceMatch.index || 0, (priceMatch.index || 0) + 30).toLowerCase().includes('week') ? 'pw' : 'pcm';
          if (forceFormat !== 'auto') result.priceFreq = forceFormat;
      }
  }

  const htmlLower = htmlString.toLowerCase();
  
  if (htmlLower.includes('zoopla.co.uk') || htmlLower.includes('"site_name":"zoopla"')) {
    result.source = 'Zoopla';
    const titleEl = doc.querySelector('title');
    if (titleEl) result.title = titleEl.textContent.split('|')[0].trim();
  } else if (htmlLower.includes('rightmove.co.uk') || htmlLower.includes('rightmove')) {
    result.source = 'Rightmove';
    const titleEl = doc.querySelector('h1') || doc.querySelector('title');
    if (titleEl) result.title = titleEl.textContent.split('-')[0].trim();
  } else if (htmlLower.includes('spareroom.co.uk') || htmlLower.includes('spareroom')) {
    result.source = 'SpareRoom';
    const titleEl = doc.querySelector('h1') || doc.querySelector('title');
    if (titleEl) result.title = titleEl.textContent.trim();
  } else {
    const titleEl = doc.querySelector('title');
    if (titleEl) result.title = titleEl.textContent.trim();
  }
  
  return result;
}

// File Upload Logic
fileInput.addEventListener('change', (e) => {
  pendingFiles = Array.from(e.target.files);
  if (pendingFiles.length === 0) {
      fileUploadBtn.textContent = 'Upload HTML/JSON Files';
      htmlInput.style.display = 'block';
      addressInput.style.display = 'block';
      return;
  }
  
  if (pendingFiles.length === 1 && pendingFiles[0].name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = function(event) {
          try {
              const imported = JSON.parse(event.target.result);
              if (Array.isArray(imported)) {
                  if (confirm(`Found ${imported.length} properties in backup. Do you want to merge them into the database?`)) {
                      properties = [...properties, ...imported.filter(ip => !properties.find(p => p.id === ip.id))];
                      saveData();
                      renderProperties();
                      alert("Successfully restored from backup!");
                  }
              }
          } catch(err) {
              alert("Invalid JSON file.");
          }
          fileInput.value = '';
          pendingFiles = [];
          fileUploadBtn.textContent = 'Upload HTML/JSON Files';
      };
      reader.readAsText(pendingFiles[0]);
      return;
  }
  
  fileUploadBtn.textContent = `Selected: ${pendingFiles.length} file(s)`;
  
  if (pendingFiles.length === 1) {
      const reader = new FileReader();
      reader.onload = function(event) {
        htmlInput.value = event.target.result;
      };
      reader.readAsText(pendingFiles[0]);
      htmlInput.style.display = 'block';
      addressInput.style.display = 'block';
  } else {
      htmlInput.style.display = 'none';
      addressInput.style.display = 'none';
  }
});

ingestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMessage.classList.add('hidden');
  
  const expectedFormat = forcePriceFreq.value;
  
  try {
    if (pendingFiles.length > 1) {
        // MASS IMPORT
        uploadProgress.classList.remove('hidden');
        let successCount = 0;
        
        for (let i = 0; i < pendingFiles.length; i++) {
            uploadProgress.textContent = `Processing file ${i + 1} of ${pendingFiles.length}...`;
            const file = pendingFiles[i];
            
            const html = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = ev => resolve(ev.target.result);
                reader.readAsText(file);
            });
            
            const newProperty = parseHTML(html, expectedFormat);
            
            if (!newProperty.hasRealCoords) {
                // Rate limit delay (1 second) before geocoding
                await new Promise(r => setTimeout(r, 1000));
                const coords = await geocodeAddress(newProperty.title.split('|')[0].split('-')[0].replace(/.*for rent in /i, '').replace(/.*to rent in /i, '').trim());
                if (coords) {
                    newProperty.lat = coords.lat;
                    newProperty.lng = coords.lng;
                    newProperty.hasRealCoords = true;
                }
            }
            
            newProperty.addedBy = localStorage.getItem('renty_user') || '';
            properties.push(newProperty);
            successCount++;
        }
        
        saveData();
        renderProperties();
        
        uploadProgress.classList.add('hidden');
        alert(`Successfully imported ${successCount} properties!`);
        
    } else {
        // SINGLE IMPORT
        const html = htmlInput.value;
        const addressFallback = addressInput.value;
        if (!html.trim()) throw new Error("Please upload a file or paste HTML code.");
        
        const newProperty = parseHTML(html, expectedFormat);
        
        if (!newProperty.hasRealCoords) {
          const coords = await geocodeAddress(addressFallback || newProperty.title.split('|')[0].split('-')[0].replace(/.*for rent in /i, '').replace(/.*to rent in /i, '').trim());
          if (coords) {
            newProperty.lat = coords.lat;
            newProperty.lng = coords.lng;
            newProperty.hasRealCoords = true;
          }
        }
        
        newProperty.addedBy = localStorage.getItem('renty_user') || '';
        properties.push(newProperty);
        saveData();
        renderProperties();
        
        map.setView([newProperty.lat, newProperty.lng], 14, { animate: true });
    }
    
    // RESET UI
    htmlInput.value = '';
    addressInput.value = '';
    fileInput.value = '';
    pendingFiles = [];
    fileUploadBtn.textContent = 'Upload HTML/JSON Files';
    htmlInput.style.display = 'block';
    addressInput.style.display = 'block';
    
  } catch (error) {
    errorMessage.textContent = 'Failed to process files. Ensure they are valid.';
    errorMessage.classList.remove('hidden');
    console.error(error);
  }
});

// UI Interactions
tabAuto.addEventListener('click', () => {
    tabAuto.style.opacity = '1';
    tabManual.style.opacity = '0.5';
    ingestForm.style.display = 'flex';
    manualForm.style.display = 'none';
});

tabManual.addEventListener('click', () => {
    tabManual.style.opacity = '1';
    tabAuto.style.opacity = '0.5';
    manualForm.style.display = 'flex';
    ingestForm.style.display = 'none';
});

// Mobile Tab Interactions
if (mobileTabList && mobileTabMap) {
    mobileTabList.addEventListener('click', () => {
        mobileTabList.classList.add('active');
        mobileTabMap.classList.remove('active');
        sidebar.style.display = 'flex';
        mapContainer.style.display = 'none';
    });
    
    mobileTabMap.addEventListener('click', () => {
        mobileTabMap.classList.add('active');
        mobileTabList.classList.remove('active');
        mapContainer.style.display = 'block';
        sidebar.style.display = 'none';
        
        // Leaflet needs to know the container size changed when unhidden
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
    });
}

// Lock Pins Toggle Interaction
lockPinsToggle.addEventListener('change', () => {
    const isLocked = lockPinsToggle.checked;
    Object.values(markers).forEach(marker => {
        if (isLocked) {
            marker.dragging.disable();
        } else {
            marker.dragging.enable();
        }
    });
});

// Manual Form Submission
if (manualForm) {
  manualForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMessage.classList.add('hidden');
    
    const title = document.getElementById('manual-title').value;
    const address = document.getElementById('manual-address').value;
    const priceNum = parseInt(document.getElementById('manual-price').value, 10);
    const priceFreq = document.getElementById('manual-price-freq').value;
    
    const newProperty = {
      id: 'prop_' + Date.now(),
      title: title,
      price: '£' + priceNum.toLocaleString(),
      priceNum: priceNum,
      priceFreq: priceFreq,
      link: '',
      hasRealCoords: false,
      notes: {},
      addedBy: localStorage.getItem('renty_user') || ''
    };
    
    // Geocode the address
    const coords = await geocodeAddress(address);
    if (coords) {
      newProperty.lat = coords.lat;
      newProperty.lng = coords.lng;
      newProperty.hasRealCoords = true;
    } else {
      errorMessage.textContent = 'Could not find that location on the map. Please be more specific.';
      errorMessage.classList.remove('hidden');
      return;
    }
    
    properties.push(newProperty);
    saveData();
    renderProperties();
    manualForm.reset();
  });
}

// Modal and Data Management
function openModal(id) {
  activePropertyId = id;
  const prop = properties.find(p => p.id === id);
  if (!prop) return;
  
  modalTitle.textContent = prop.title;
  modalPrice.textContent = formatPrice(prop);
  modalLink.href = prop.link || '#';
  modalLink.style.display = prop.link ? 'inline-block' : 'none';
  
  const notesEl = document.getElementById('modal-notes');
  const otherNotesContainer = document.getElementById('other-notes-container');
  const currentUser = localStorage.getItem('renty_user') || 'Unknown';
  
  // Migrate legacy string notes
  if (typeof prop.notes === 'string') {
    prop.notes = { [prop.lastModifiedBy || 'Unknown']: prop.notes };
  } else if (!prop.notes) {
    prop.notes = {};
  }
  
  notesEl.value = prop.notes[currentUser] || '';
  
  // Render other users' notes
  if (otherNotesContainer) {
    otherNotesContainer.innerHTML = '';
    for (const [user, noteText] of Object.entries(prop.notes)) {
      if (user !== currentUser && noteText.trim() !== '') {
        const noteDiv = document.createElement('div');
        noteDiv.style.background = 'rgba(255,255,255,0.03)';
        noteDiv.style.padding = '8px';
        noteDiv.style.borderRadius = '8px';
        noteDiv.style.border = '1px dashed var(--sidebar-border)';
        noteDiv.innerHTML = `<strong style="font-size: 11px; color: var(--text-secondary);">${user}:</strong> <p style="font-size: 13px; margin-top: 4px; color: var(--text-primary); margin-bottom:0;">${noteText.replace(/\n/g, '<br>')}</p>`;
        otherNotesContainer.appendChild(noteDiv);
      }
    }
  }
  
  // Display Tracking Info
  let metaHTML = '';
  if (prop.addedBy) metaHTML += `<span style="font-size: 10px; color: var(--text-secondary); margin-right: 15px;">Added by: <strong style="color:var(--text-primary);">${prop.addedBy}</strong></span>`;
  
  let metaContainer = document.getElementById('modal-meta');
  if (!metaContainer) {
    metaContainer = document.createElement('div');
    metaContainer.id = 'modal-meta';
    metaContainer.style.marginBottom = '15px';
    notesEl.parentNode.insertBefore(metaContainer, notesEl);
  }
  metaContainer.innerHTML = metaHTML;
  
  noteModal.classList.remove('hidden');
}

function closeModal() {
  noteModal.classList.add('hidden');
  activePropertyId = null;
}

closeModalBtn.addEventListener('click', closeModal);
noteModal.addEventListener('click', (e) => {
  if (e.target === noteModal) closeModal();
});

updateLocationBtn.addEventListener('click', async () => {
  if (!activePropertyId) return;
  const address = modalAddress.value;
  if (!address) return;
  
  updateLocationBtn.textContent = '...';
  const geo = await geocodeAddress(address);
  if (geo) {
      const prop = properties.find(p => p.id === activePropertyId);
      if (prop) {
          prop.lat = geo.lat;
          prop.lng = geo.lng;
          saveData();
          
          if (markers[prop.id]) {
              markers[prop.id].setLatLng([geo.lat, geo.lng]);
              map.setView([geo.lat, geo.lng], 15, { animate: true });
          }
      }
      modalAddress.value = '';
  } else {
      alert('Could not find that location in the UK!');
  }
  updateLocationBtn.textContent = 'Search';
});

saveNotesBtn.addEventListener('click', () => {
  if (!activePropertyId) return;
  const prop = properties.find(p => p.id === activePropertyId);
  if (prop) {
    const newNotes = modalNotes.value;
    const currentUser = localStorage.getItem('renty_user') || 'Unknown';
    
    if (typeof prop.notes === 'string') {
       prop.notes = { [prop.lastModifiedBy || 'Unknown']: prop.notes };
    } else if (!prop.notes) {
       prop.notes = {};
    }
    
    if (prop.notes[currentUser] !== newNotes) {
      prop.notes[currentUser] = newNotes;
      prop.lastModifiedBy = currentUser;
      saveData();
    }
    closeModal();
    renderProperties(); // Re-render to potentially update list if needed
  }
});

deletePropertyBtn.addEventListener('click', async () => {
  if (!activePropertyId) return;
  
  // Remove marker from map
  if (markers[activePropertyId]) {
    map.removeLayer(markers[activePropertyId]);
    delete markers[activePropertyId];
  }
  
  const idToDelete = activePropertyId;
  properties = properties.filter(p => p.id !== idToDelete);
  saveData();
  renderProperties();
  closeModal();
  
  // Explicitly delete from cloud immediately
  try {
      await deleteDoc(doc(db, 'locations', idToDelete));
  } catch(e) {}
});

exportBtn.addEventListener('click', () => {
    const dataStr = localStorage.getItem('renty_properties') || '[]';
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `renty-locations-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

function saveData() {
  // 1. Instantly save to local storage (for fast UI response and crash safety)
  localStorage.setItem('renty_properties', JSON.stringify(properties));
  localStorage.setItem('renty_pending_sync', 'true');
  
  // 2. Clear any existing timer
  if (syncTimeout) clearTimeout(syncTimeout);
  
  // 3. Start a new 3-second timer
  syncTimeout = setTimeout(async () => {
    isSyncing = true;
    try {
        // Ensure every property has an ID (legacy JSON imports might lack them)
        properties.forEach(prop => {
            if (!prop.id) {
                prop.id = 'prop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            }
        });
        
        const cleanProperties = JSON.parse(JSON.stringify(properties));
        const chunkSize = 500;
        for (let i = 0; i < cleanProperties.length; i += chunkSize) {
            const chunk = cleanProperties.slice(i, i + chunkSize);
            const batch = writeBatch(db);
            chunk.forEach(prop => {
                const docRef = doc(db, 'locations', prop.id);
                batch.set(docRef, prop);
            });
            await batch.commit();
        }
        localStorage.removeItem('renty_pending_sync');
        console.log('Successfully synced batch to cloud!');
    } catch (e) {
        console.error('Failed to sync to cloud:', e);
    } finally {
        isSyncing = false;
        syncTimeout = null;
    }
  }, 3000);
}

// Initial render
// Small delay to ensure map container is fully loaded
setTimeout(() => {
    map.invalidateSize();
    renderProperties();
    
    // Resume syncing if the user refreshed the page before a previous save finished
    if (localStorage.getItem('renty_pending_sync')) {
        saveData();
    }
}, 100);

// Setup real-time listener from Firestore
const locationsRef = collection(db, 'locations');
onSnapshot(locationsRef, (snapshot) => {
    // Only accept cloud updates if we aren't currently waiting to push our own local changes
    // This prevents the cloud from overwriting our local drag before it settles.
    if (syncTimeout || isSyncing || localStorage.getItem('renty_pending_sync')) return;
    
    let cloudProperties = [];
    snapshot.forEach((doc) => {
        cloudProperties.push(doc.data());
    });
    
    if (cloudProperties.length > 0) {
        properties = cloudProperties;
        localStorage.setItem('renty_properties', JSON.stringify(properties));
        
        // Clean up old markers
        Object.values(markers).forEach(m => map.removeLayer(m));
        for (let key in markers) delete markers[key];
        
        renderProperties();
    }
});
