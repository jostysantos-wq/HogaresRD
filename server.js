const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/submit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});

app.post('/submit', (req, res) => {
  const property = req.body;
  console.log('New property submission:', property);
  // TODO: save to database
  res.json({ success: true, message: 'Propiedad recibida correctamente.' });
});

app.listen(PORT, () => {
  console.log(`HogaresRD running at http://localhost:${PORT}`);
});
