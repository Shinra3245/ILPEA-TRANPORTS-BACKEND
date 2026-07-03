/**
 * Plantilla ILPEA — 14 unidades (ruta × tipo × asientos).
 * Códigos Samsara donde existen; placeholders R5/R11/R12/R13.
 */

const TIPOS_VALIDOS = new Set(['AUTOBUS', 'VAN', 'SPRINTER']);

const UNIDADES_BASE = [
  { ruta_numero: 1, tipo_imagen: 'CAMION', capacidad: 30, codigo: 'E0234' },
  { ruta_numero: 2, tipo_imagen: 'CAMION', capacidad: 30, codigo: 'E0322' },
  { ruta_numero: 3, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0008' },
  { ruta_numero: 4, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0068' },
  { ruta_numero: 5, tipo_imagen: 'VAN', capacidad: 12, codigo: 'R5' },
  { ruta_numero: 6, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0036' },
  { ruta_numero: 7, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0056' },
  { ruta_numero: 8, tipo_imagen: 'CAMION', capacidad: 30, codigo: 'E0334' },
  { ruta_numero: 9, tipo_imagen: 'CAMION', capacidad: 30, codigo: 'E0372' },
  { ruta_numero: 10, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0126' },
  { ruta_numero: 11, tipo_imagen: 'VAN', capacidad: 12, codigo: 'R11' },
  { ruta_numero: 12, tipo_imagen: 'SPRINTER', capacidad: 19, codigo: 'R12' },
  { ruta_numero: 13, tipo_imagen: 'VAN', capacidad: 12, codigo: 'R13' },
  { ruta_numero: 14, tipo_imagen: 'VAN', capacidad: 12, codigo: 'C0118' },
];

const IDS_PLANTILLA = new Set();

function slugVehiculoId(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function normalizarTipoUnidad(tipoTexto) {
  const tipo = String(tipoTexto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (tipo.includes('autobus') || tipo.includes('camion')) {
    return 'AUTOBUS';
  }
  if (tipo.includes('sprinter')) {
    return 'SPRINTER';
  }
  if (tipo.includes('van')) {
    return 'VAN';
  }
  const upper = String(tipoTexto || '').trim().toUpperCase();
  return TIPOS_VALIDOS.has(upper) ? upper : null;
}

function etiquetaTipoImagen(tipoCanonico) {
  if (tipoCanonico === 'AUTOBUS') return 'CAMION';
  if (tipoCanonico === 'SPRINTER') return 'SPRINTER';
  if (tipoCanonico === 'VAN') return 'VAN';
  return tipoCanonico || '—';
}

function idVehiculoPorCodigo(codigo) {
  const slug = slugVehiculoId(codigo);
  return slug ? `veh_${slug}` : null;
}

function construirPlantillaUnidades() {
  const unidades = [];

  UNIDADES_BASE.forEach((item) => {
    const id = idVehiculoPorCodigo(item.codigo);
    if (!id) {
      return;
    }

    IDS_PLANTILLA.add(id);
    unidades.push({
      id,
      codigo: item.codigo,
      tipo: normalizarTipoUnidad(item.tipo_imagen),
      capacidad: item.capacidad,
      placas: null,
      ruta_numero: item.ruta_numero,
      estado: 'activo',
      es_plantilla: true,
    });
  });

  return unidades;
}

const PLANTILLA_UNIDADES = construirPlantillaUnidades();

function esIdPlantillaUnidad(vehiculoId) {
  return IDS_PLANTILLA.has(String(vehiculoId || '').toLowerCase());
}

function capacidadPorTipo(tipo, capacidadExplicita) {
  const capacidad = Number(capacidadExplicita);
  if (Number.isInteger(capacidad) && capacidad > 0) {
    return capacidad;
  }
  if (tipo === 'AUTOBUS') return 30;
  if (tipo === 'SPRINTER') return 19;
  if (tipo === 'VAN') return 12;
  return 12;
}

module.exports = {
  TIPOS_VALIDOS,
  PLANTILLA_UNIDADES,
  IDS_PLANTILLA,
  UNIDADES_BASE,
  normalizarTipoUnidad,
  etiquetaTipoImagen,
  slugVehiculoId,
  idVehiculoPorCodigo,
  esIdPlantillaUnidad,
  capacidadPorTipo,
  construirPlantillaUnidades,
};
