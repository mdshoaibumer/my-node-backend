const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { registerFont } = require('canvas'); // Required to register custom fonts
const path = require('path');

// Register Roboto fonts before creating the chart instance
registerFont(path.join(__dirname, '../../fonts/Roboto-Regular.ttf'), {
  family: 'Roboto',
  weight: 'normal'
});
registerFont(path.join(__dirname, '../../fonts/Roboto-Bold.ttf'), {
  family: 'Roboto',
  weight: 'bold'
});
registerFont(path.join(__dirname, '../../fonts/Roboto-Italic.ttf'), {
  family: 'Roboto',
  weight: 'normal',
  style: 'italic'
});
registerFont(path.join(__dirname, '../../fonts/Roboto-BoldItalic.ttf'), {
  family: 'Roboto',
  weight: 'bold',
  style: 'italic'
});

const width = 600;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
  width, 
  height,
  backgroundColour: 'white'
});

async function generateSeverityChart(metrics) {
  const severityData = Object.entries(metrics.severityBreakdown)
    .sort(([a], [b]) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a] - order[b];
    });

  const configuration = {
    type: 'doughnut',
    data: {
      labels: severityData.map(([label]) => label.toUpperCase()),
      datasets: [{
        data: severityData.map(([_, count]) => count),
        backgroundColor: [
          '#e74c3c', // critical
          '#f39c12', // high
          '#3498db', // medium
          '#2ecc71'  // low
        ],
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            font: {
              size: 14,
              family: 'Roboto' // Now using registered font
            },
            padding: 20
          }
        },
        title: {
          display: true,
          text: 'Accessibility Violations by Severity',
          font: {
            size: 16,
            family: 'Roboto' // Now using registered font
          },
          padding: {
            top: 10,
            bottom: 30
          }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const value = context.raw || 0;
              const percentage = Math.round((value / total) * 100);
              return `${context.label}: ${value} (${percentage}%)`;
            }
          }
        }
      }
    }
  };

  const image = await chartJSNodeCanvas.renderToBuffer(configuration);
  return image;
}

module.exports = {
  generateSeverityChart
};