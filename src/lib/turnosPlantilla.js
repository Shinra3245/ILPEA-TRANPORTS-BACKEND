/**
 * Plantilla semanal de turnos (estilo Excel ILPEA).
 * Lun–Vie: 1er, 2do, Mixto, 3er | Sáb–Dom: 1er, 2do, 3er
 */

const DIAS_SEMANA = [
  { prefijo: 'lun', dia_semana: 1, dia_nombre: 'Lunes' },
  { prefijo: 'mar', dia_semana: 2, dia_nombre: 'Martes' },
  { prefijo: 'mie', dia_semana: 3, dia_nombre: 'Miércoles' },
  { prefijo: 'jue', dia_semana: 4, dia_nombre: 'Jueves' },
  { prefijo: 'vie', dia_semana: 5, dia_nombre: 'Viernes' },
  { prefijo: 'sab', dia_semana: 6, dia_nombre: 'Sábado' },
  { prefijo: 'dom', dia_semana: 7, dia_nombre: 'Domingo' },
];

const TIPOS_LUN_VIE = [
  { tipo: '1er', nombre: '1er Turno', hora_inicio: '06:00', hora_fin: '14:00', orden: 1 },
  { tipo: '2do', nombre: '2do Turno', hora_inicio: '14:00', hora_fin: '22:00', orden: 2 },
  { tipo: 'mixto', nombre: 'Mixto', hora_inicio: '06:00', hora_fin: '14:00', orden: 3 },
  { tipo: '3er', nombre: '3er Turno', hora_inicio: '22:00', hora_fin: '06:00', orden: 4 },
];

const TIPOS_FIN_SEMANA = [
  { tipo: '1er', nombre: '1er Turno', hora_inicio: '06:00', hora_fin: '14:00', orden: 1 },
  { tipo: '2do', nombre: '2do Turno', hora_inicio: '14:00', hora_fin: '22:00', orden: 2 },
  { tipo: '3er', nombre: '3er Turno', hora_inicio: '22:00', hora_fin: '06:00', orden: 3 },
];

const DIA_POR_PREFIJO = Object.fromEntries(DIAS_SEMANA.map((d) => [d.prefijo, d.dia_semana]));

const TIPOS_VALIDOS = new Set(['1er', '2do', 'mixto', '3er']);

const IDS_PLANTILLA = new Set();

function construirPlantillaTurnos() {
  const turnos = [];

  DIAS_SEMANA.forEach((dia) => {
    const tipos = dia.dia_semana <= 5 ? TIPOS_LUN_VIE : TIPOS_FIN_SEMANA;
    tipos.forEach((tipoInfo) => {
      const id = `${dia.prefijo}_${tipoInfo.tipo}`;
      IDS_PLANTILLA.add(id);
      turnos.push({
        id,
        nombre: tipoInfo.nombre,
        dia_semana: dia.dia_semana,
        dia_nombre: dia.dia_nombre,
        tipo: tipoInfo.tipo,
        orden: tipoInfo.orden,
        dias_operacion: [dia.dia_semana],
        hora_inicio: tipoInfo.hora_inicio,
        hora_fin: tipoInfo.hora_fin,
        activo: true,
        es_plantilla: true,
      });
    });
  });

  return turnos;
}

const PLANTILLA_TURNOS = construirPlantillaTurnos();

function esIdPlantilla(turnoId) {
  return IDS_PLANTILLA.has(String(turnoId || '').toLowerCase());
}

function diaSemanaPorPrefijoId(turnoId) {
  const prefijo = String(turnoId || '').toLowerCase().split('_')[0];
  return DIA_POR_PREFIJO[prefijo] || null;
}

function normalizarTipoTurno(tipo) {
  const texto = String(tipo || '').trim().toLowerCase();
  if (texto === '1' || texto === '1er' || texto === 'primer') return '1er';
  if (texto === '2' || texto === '2do' || texto === 'segundo') return '2do';
  if (texto === '3' || texto === '3er' || texto === 'tercer') return '3er';
  if (texto === 'mixto') return 'mixto';
  return TIPOS_VALIDOS.has(texto) ? texto : null;
}

function slugTurnoId(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

module.exports = {
  DIAS_SEMANA,
  TIPOS_VALIDOS,
  PLANTILLA_TURNOS,
  IDS_PLANTILLA,
  esIdPlantilla,
  diaSemanaPorPrefijoId,
  normalizarTipoTurno,
  slugTurnoId,
  construirPlantillaTurnos,
};
