/**
 * JZ Human Atlas Embed - Qlik Sense Extension
 * 3D Human Anatomy Visualization with Qlik Integration
 *
 * Copyright (c) 2024 Jochem Zwienenberg, Qlik
 */
define([
  'jquery',
  'qlik',
  'text!./style.css'
], function($, qlik, cssContent) {
  'use strict';

  $('<style>').html(cssContent).appendTo('head');

  const instanceState = new Map();

  return {
    initialProperties: {
      qHyperCubeDef: {
        qDimensions: [],
        qMeasures: [],
        qInitialDataFetch: [{ qWidth: 10, qHeight: 5000 }],
        qSuppressZero: false,
        qSuppressMissing: false,
        qMode: 'S'
      },
      showSystemsPanel: false,
      showInfoPanel: true,
      iframeUrl: 'https://5c7febc9-1d66-403b-955b-ade3ed4e03c8-00-utqzmhghz4wv.spock.replit.dev',
      borderColor: '',
      borderWidth: 0,
      enableZoomIn: true,
      zoomInDuration: 2.5
    },

    definition: {
      type: 'items',
      component: 'accordion',
      items: {
        dimensions: {
          uses: 'dimensions',
          min: 1,
          max: 2,
          label: 'Body Part (1st=name, 2nd=code optional)'
        },
        measures: {
          uses: 'measures',
          min: 0,
          max: 1,
          label: 'Value (optional)'
        },
        settings: {
          uses: 'settings',
          items: {
            iframe: {
              type: 'items',
              label: 'Iframe Settings',
              items: {
                iframeUrl: {
                  type: 'string',
                  label: 'Wrapper URL',
                  ref: 'iframeUrl',
                  expression: 'optional',
                  defaultValue: ''
                },
                showInfoPanel: {
                  type: 'boolean',
                  label: 'Show Selection Panel',
                  ref: 'showInfoPanel',
                  defaultValue: true
                },
                enableZoomIn: {
                  type: 'boolean',
                  label: 'Zoom-in Animation on Load',
                  ref: 'enableZoomIn',
                  defaultValue: true
                },
                zoomInDuration: {
                  type: 'number',
                  label: 'Zoom Duration (seconds)',
                  ref: 'zoomInDuration',
                  defaultValue: 1.2,
                  min: 0.3,
                  max: 3,
                  show: function(data) { return data.enableZoomIn; }
                }
              }
            },
            border: {
              type: 'items',
              label: 'Border',
              items: {
                borderColor: {
                  type: 'string',
                  label: 'Border Color (hex, rgba)',
                  ref: 'borderColor',
                  expression: 'optional',
                  defaultValue: ''
                },
                borderWidth: {
                  type: 'number',
                  label: 'Border Width (px)',
                  ref: 'borderWidth',
                  defaultValue: 0,
                  min: 0,
                  max: 20
                }
              }
            }
          }
        }
      }
    },

    support: {
      snapshot: true,
      export: true,
      exportData: true
    },

    paint: function($element, layout) {
      const self = this;
      const objectId = layout.qInfo.qId;

      let state = instanceState.get(objectId);
      if (!state) {
        state = {
          iframeReady: false,
          iframe: null,
          currentUrl: null,
          messageHandler: null,
          lastSentParts: null,
          selectableParts: [],
          backendApi: null,
          allPartsCache: new Map()
        };
        instanceState.set(objectId, state);
      }

      // Update state with current backendApi and data (for message handler to use)
      state.backendApi = self.backendApi;

      if (!layout.iframeUrl || layout.iframeUrl.trim() === '') {
        $element.html(`
          <div style="padding: 40px; text-align: center; color: #333;">
            <h3>Configuration Required</h3>
            <p>Enter Wrapper URL in Properties → Iframe Settings</p>
          </div>
        `);
        return;
      }

      const qMatrix = layout.qHyperCube.qDataPages[0]?.qMatrix || [];
      const dimInfo = layout.qHyperCube.qDimensionInfo?.[0];
      const stateCounts = dimInfo?.qStateCounts || {};
      const excludedCount = (stateCounts.qExcluded || 0) + (stateCounts.qSelectedExcluded || 0) + (stateCounts.qLockedExcluded || 0);

      // Build map of current states from qMatrix
      // qState: 'S' = selected, 'O' = optional (can select), 'X' = excluded, 'L' = locked, 'A' = alternative
      const currentStates = new Map();
      const selectedParts = [];

      // Check if we have a second dimension for part code
      const hasCodeDim = layout.qHyperCube.qDimensionInfo?.length > 1;

      qMatrix.forEach(row => {
        const cell = row[0];
        if (!cell) return;

        const partName = cell.qText;
        const partCode = hasCodeDim && row[1] ? row[1].qText : null;
        const elemNumber = cell.qElemNumber;
        const qState = cell.qState;

        // Always update cache with latest elemNumber and code
        if (!state.allPartsCache.has(partName)) {
          state.allPartsCache.set(partName, { elemNumber, code: partCode });
        } else if (partCode && !state.allPartsCache.get(partName).code) {
          // Update code if we didn't have it before
          state.allPartsCache.get(partName).code = partCode;
        }

        currentStates.set(partName, { qState, elemNumber, code: partCode });

        if (qState === 'S') {
          selectedParts.push(partName);
        }
      });

      // Detect filtering: use qStateCounts to check if any values are excluded by other selections
      const isFiltered = excludedCount > 0;
      const hasDirectSelection = selectedParts.length > 0;

      // Build selectableParts from CACHE (all known parts) + current states
      // This ensures we always have all parts even after selections filter qMatrix
      const selectableParts = [];

      state.allPartsCache.forEach((cacheData, partName) => {
        const { elemNumber, code } = cacheData;
        const currentState = currentStates.get(partName);
        const isInCurrentMatrix = currentState !== undefined;
        const qState = currentState ? currentState.qState : 'X'; // Parts not in matrix are excluded

        // Include all parts except truly excluded ones (state 'X')
        if (qState !== 'X') {
          // Mark as selected if:
          // 1. Direct selection (qState === 'S'), OR
          // 2. Filtering is active AND this part is in the filtered result (isInCurrentMatrix)
          const isSelected = qState === 'S' || (isFiltered && isInCurrentMatrix && !hasDirectSelection);

          selectableParts.push({
            name: partName,
            code: code || null,
            elemNumber: elemNumber,
            isSelected: isSelected
          });
        }
      });

      // Count actual selected parts for logging
      const highlightedParts = selectableParts.filter(p => p.isSelected).map(p => p.name);
      const showFullModel = !isFiltered && !hasDirectSelection;

      // Store selectableParts in state so messageHandler can access current data
      state.selectableParts = selectableParts;

      console.log('📊 Qlik data:', {
        matrixRows: qMatrix.length,
        cachedParts: state.allPartsCache.size,
        excludedCount: excludedCount,
        selectable: selectableParts.length,
        highlighted: highlightedParts.length,
        isFiltered: isFiltered,
        showFullModel: showFullModel
      });

      function sendToIframe(type, data) {
        if (state.iframeReady && state.iframe?.contentWindow) {
          state.iframe.contentWindow.postMessage({ source: 'qlik', type, data }, '*');
          console.log('📤 Sent to iframe:', type);
        }
      }

      function updateIframe() {
        sendToIframe('settings', {
          showSystemsPanel: layout.showSystemsPanel !== false,
          showInfoPanel: layout.showInfoPanel !== false,
          showStatusBar: layout.showStatusBar !== false
        });

        // Build cache key
        const partsKey = showFullModel ? 'FULL' : JSON.stringify(selectableParts.map(p => p.name).sort());

        if (partsKey !== state.lastSentParts) {
          if (showFullModel) {
            // No filter active - show full model and zoom to fit
            sendToIframe('showFullModel', { zoomToFit: true });
          } else {
            // Filter active - show only selectable parts and zoom to fit them
            // highlightedParts includes both direct selections AND filter-based visibility
            sendToIframe('setSelectableParts', {
              parts: selectableParts,
              selectedParts: highlightedParts,
              zoomToFit: true
            });
          }
          state.lastSentParts = partsKey;
        }
      }

      const needsRebuild = !state.iframe || state.currentUrl !== layout.iframeUrl;

      if (needsRebuild) {
        if (state.messageHandler) {
          window.removeEventListener('message', state.messageHandler);
        }

        state.iframeReady = false;
        state.currentUrl = layout.iframeUrl;
        state.lastSentParts = null;

        $element.empty();

        const $container = $('<div>')
          .css({ width: '100%', height: '100%', position: 'relative', background: 'transparent', boxSizing: 'border-box', overflow: 'hidden' })
          .appendTo($element);

        // Animation disabled - was animating UI elements too

        // Apply border if configured
        if (layout.borderColor && layout.borderWidth > 0) {
          const color = String(layout.borderColor).trim();
          $container.css('border-width', layout.borderWidth + 'px');
          $container.css('border-style', 'solid');
          $container.css('border-color', color);
          console.log('🖼️ Border applied:', layout.borderWidth + 'px', color);
        }

        const $iframe = $('<iframe>')
          .attr({ src: layout.iframeUrl, frameborder: '0', sandbox: 'allow-scripts allow-same-origin', allowtransparency: 'true' })
          .css({ width: '100%', height: '100%', border: 'none', background: 'transparent' })
          .appendTo($container);

        state.iframe = $iframe[0];

        state.messageHandler = function(event) {
          if (event.data?.source !== 'human-atlas') return;

          switch (event.data.type) {
            case 'ready':
              state.iframeReady = true;
              console.log('✅ Iframe ready');
              updateIframe();
              break;

            case 'applySelection':
              // User clicked "Select" button in the viewer
              // event.data.data.parts = array of part names to select
              const partsToSelect = event.data.data.parts || [];
              console.log('🎯 Apply selection from viewer:', partsToSelect);

              if (partsToSelect.length > 0 && state.backendApi) {
                // Try to find elemNumbers for parts in current filter
                const elemNumbers = [];
                const partsNotFound = [];

                partsToSelect.forEach(partName => {
                  const found = state.selectableParts.find(p => p.name === partName);
                  if (found && found.elemNumber >= 0) {
                    elemNumbers.push(found.elemNumber);
                  } else {
                    partsNotFound.push(partName);
                  }
                });

                // Select parts that have elemNumbers
                if (elemNumbers.length > 0) {
                  console.log('📤 Selecting elemNumbers:', elemNumbers);
                  state.backendApi.selectValues(0, elemNumbers, false);
                  console.log('✅ Selected', elemNumbers.length, 'parts via elemNumber');
                }

                // For parts not in current filter, use field selection by value
                if (partsNotFound.length > 0) {
                  console.log('🔍 Parts not in filter, trying field selection:', partsNotFound);
                  try {
                    const app = qlik.currApp(this);
                    const dimInfo = layout.qHyperCube.qDimensionInfo[0];
                    const fieldName = dimInfo.qFallbackTitle || dimInfo.qGroupFieldDefs[0];
                    console.log('📌 Field name:', fieldName);

                    if (fieldName && app) {
                      // Select values by field name
                      app.field(fieldName).selectValues(
                        partsNotFound.map(v => ({ qText: v })),
                        true,  // toggle
                        false  // soft lock
                      ).then(() => {
                        console.log('✅ Selected', partsNotFound.length, 'parts via field API');
                      }).catch(err => {
                        console.warn('⚠️ Field selection failed:', err);
                      });
                    }
                  } catch (err) {
                    console.warn('⚠️ Could not use field selection:', err);
                  }
                }

                if (elemNumbers.length === 0 && partsNotFound.length === 0) {
                  console.warn('⚠️ No parts to select');
                }
              } else {
                console.log('⚠️ Cannot select: no parts or no backendApi');
              }
              break;

            case 'clearSelection':
              console.log('🧹 Clear selection from viewer');
              // Clear selections using backendApi
              if (state.backendApi) {
                state.backendApi.clearSelections();
                console.log('✅ Cleared selections via backendApi');
              }
              break;
          }
        };

        window.addEventListener('message', state.messageHandler);

      } else if (state.iframeReady) {
        updateIframe();

        // Update border styling if changed
        const $container = $element.find('> div').first();
        if ($container.length) {
          if (layout.borderColor && layout.borderWidth > 0) {
            const color = String(layout.borderColor).trim();
            $container.css('border-width', layout.borderWidth + 'px');
            $container.css('border-style', 'solid');
            $container.css('border-color', color);
          } else {
            $container.css('border', 'none');
          }
        }
      }
    }
  };
});
